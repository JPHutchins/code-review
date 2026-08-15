// Single source of truth for the bits every render surface (sticky, inline comment, review body)
// must agree on: severity→emoji, the machine-readable findings-json marker, and patch→suggestion
// projection. Pure.

import { DEFAULT_SCHEMA_VERSION } from "./schema.js";
import type { Finding, Findings, ScopeMetastasis, Severity, SystemicProblem } from "./schema.js";
import type { CodeCounts, CodeStreak, RoundRecord, SeverityCounts } from "./types.js";
import { patchToSuggestion } from "./patch.js";

export const severityEmoji = (s: string): string => {
  switch (s) {
    case "critical":
      return "🔴";
    case "major":
      return "🟠";
    case "minor":
      return "🔵";
    case "nit":
      return "⚪";
    default:
      return "❓";
  }
};

// ~32KB of JSON in base64 — well under GitHub's 65536-char comment limit. Post-#156 the embedded blob
// is the agent's COMPLETE document with NO pipeline overhead: the stop signal rides its own
// ~165-char compact signal marker BESIDE the blob (never inside it), and scope_metastasis is
// re-derived at seed time rather than carried. The value is kept at the pre-#156 boundary as a
// deliberate backward-compat margin, so every review that embedded before the surfacing transform
// was deleted still embeds — the payload ceiling only rose (the ~2.5KB worst-case surfaced overhead
// is gone), and the ~165 chars that moved outside the blob grow the whole comment by ~0.3% of the
// 65536 ceiling, well inside the headroom. The AGENTS_STOP_DIRECTIVE (~0.6KB, issue #171) rides ahead
// of the marker on every surface too — the same small-fraction-of-headroom order, well inside it. The
// link fallback loses only the re-review findings seed — never the stop signal, which survives in the
// compact marker.
export const EMBED_LIMIT = 42700;

// The canonical location of the findings schema — the moving `main` ref (mirrors findings.schema.json's
// own $id). No version tag is cut yet; a tagged schema pins its own $id (schema/VERSIONING.md), so a
// decoding agent starts here and, if its document's schema_version names a different version, fetches
// that one — the URL below is NOT version-pinned.
const FINDINGS_SCHEMA_URL =
  "https://raw.githubusercontent.com/JPHutchins/code-review/main/schema/findings.schema.json";

// Travels with the marker on every surface so a reader who sees only one comment still knows to decode
// it AND to read the schema before acting. Imperative and loud on purpose: lazy consumers cherry-pick
// fields out of the JSON and act on only what they recognize, missing the machine-channel recurrence
// signals that are documented in the schema and decodable from the sibling markers (issue #171). Uses
// em dashes, never "--", so the HTML comment stays well-formed. Exported so the surfaces and their
// tests share one SSOT for the directive text (it is carried forward verbatim by carryForwardMarkers).
export const AGENTS_STOP_DIRECTIVE = `<!-- AGENTS: STOP — this comment is a machine channel; act on the data, not the prose. It embeds a base64 code-review findings JSON. Decode it, read its schema_version, then DOWNLOAD AND READ THE FULL SCHEMA for that version before you act — the schema's own $id is its canonical URL; the current schema is at ${FINDINGS_SCHEMA_URL}. Parse the WHOLE document and every code-review:* marker (findings, signal, rounds), not only the fields you recognize: the recurrence signals an iterating agent needs (round streaks, scope metastasis, same-mechanism) are decodable there. -->`;

// The base64 length of a document's JSON — the one size computation both encodeMarker and
// findingsMarkerForm share, so the form report and the emitted marker can never disagree.
const b64LengthOf = (document: unknown): number =>
  Buffer.from(JSON.stringify(document), "utf-8").toString("base64").length;

const encodeMarker = (document: unknown, jsonUrl: string | undefined, limit: number): string => {
  const b64 = Buffer.from(JSON.stringify(document), "utf-8").toString("base64");
  const marker =
    b64.length <= limit
      ? `<!-- code-review:findings-json;base64 ${b64} -->`
      : jsonUrl
        ? `<!-- code-review:findings-json ${jsonUrl} -->`
        : "";
  return marker ? `${AGENTS_STOP_DIRECTIVE}\n${marker}` : "";
};

// Decode a base64-in-HTML-comment marker payload, shared by the findings + rounds markers; undefined
// on any malformed input so callers degrade rather than throw on the render path.
const decodeBase64Json = (b64: string): unknown => {
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    return undefined;
  }
};

export const findingsPointer = (
  findings: Findings,
  jsonUrl: string | undefined,
  limit = EMBED_LIMIT,
): string => encodeMarker(findings, jsonUrl, limit);

// The form findingsPointer will emit for a whole-document marker, exposed so the IO-bound callers
// (post) can warn when the embedded machine channel degrades instead of failing silently — only the
// base64 form is decodable back (parseFindingsMarker), so "link"/"omitted" silently drop the seed
// for a re-review.
export type FindingsMarkerForm = "embedded" | "link" | "omitted";

export const findingsMarkerForm = (
  findings: Findings,
  jsonUrl: string | undefined,
  limit = EMBED_LIMIT,
): FindingsMarkerForm => {
  if (b64LengthOf(findings) <= limit) return "embedded";
  return jsonUrl ? "link" : "omitted";
};

// Per-finding counterpart: an inline comment embeds only its own finding, so the sticky and review
// body stay the whole-document SSOT.
export const findingPointer = (
  finding: Finding,
  schemaVersion: string,
  jsonUrl?: string,
  limit = EMBED_LIMIT,
): string => encodeMarker({ schema_version: schemaVersion, findings: [finding] }, jsonUrl, limit);

// null when the marker is absent or holds the all-zeros placeholder (no head SHA was stamped),
// so callers treat an unknown prior commit as a new-commit re-review rather than asserting a match.
const ZERO_SHA = "0000000000000000000000000000000000000000";
export const parseReviewedSha = (body: string): string | null => {
  const sha = /<!-- reviewed-sha: ([0-9a-fA-F]{40}) -->/.exec(body)?.[1]?.toLowerCase();
  return sha && sha !== ZERO_SHA ? sha : null;
};

// The route of the COMPLETED review that stamped the sticky ("full review" | "mechanic"; absent on
// notices and on pre-route-marker stickies). The seed chain is route-aware on it: a CI-fix mechanic
// pass must not seed a later full review as if it were the previous full review (issue #127).
const ROUTE_RE = /<!-- reviewed-route: ([^>]*) -->/;
export const parseReviewedRoute = (body: string): string | null => ROUTE_RE.exec(body)?.[1] || null;

// Post's empty-mechanic guard predicate: "does this sticky record a completed FULL review as its
// last completed review?" The route marker wins — a mechanic sticky carries a prior full review's
// round history forward, so round history alone can't distinguish it — and round history is the
// fallback for pre-route-marker stickies (only a completed full review ever APPENDS a round; a
// mechanic can only carry one). With no signal at all the review is not classified as full here;
// post adds its own completed-review fallbacks (review-complete, or the placeholder's
// completed-ancestor marker) for the pre-rounds era. seed-draft deliberately does NOT use this
// predicate: for seeding, a no-route prior is unknown (a pre-route mechanic that carried rounds
// looks identical to a pre-route full review), and the false-prior direction is worse than one cold
// review, so it requires the route marker outright.
export const isFullReviewSticky = (body: string): boolean => {
  const route = parseReviewedRoute(body);
  return route === "full review" || (route !== "mechanic" && parseRounds(body).length > 0);
};

// Carried by the announce placeholder when the sticky it replaced was a COMPLETED review: the
// placeholder strips review-complete (it must not read as a finished review of the new head), yet
// the empty-mechanic guard needs to know the placeholder descends from a completed review to
// protect a pre-route/pre-rounds full review that would otherwise lose every signal (issue #127
// round-2). Only ever carried — never emitted by a completed render, which has review-complete.
export const COMPLETED_ANCESTOR_MARKER = "<!-- review-complete-ancestor -->";
export const parseCompletedAncestor = (body: string): boolean =>
  body.includes(COMPLETED_ANCESTOR_MARKER);

// A POSITIVE marker: present only in a sticky the commenter wrote for a COMPLETED review. It is
// absent from an incomplete notice AND from an in-progress placeholder (which carries forward a prior
// review's reviewed-sha yet is not itself a completed review) — so a precedence check can tell those
// apart, which reviewed-sha alone (stamped on notices too) cannot. Re-emitted by the template each
// write from the render's `incomplete` flag, never carried forward.
export const REVIEW_COMPLETE_MARKER = "<!-- review-complete -->";
export const parseReviewComplete = (body: string): boolean => body.includes(REVIEW_COMPLETE_MARKER);

// null when the body carries no base64 marker (e.g. the jsonUrl-link fallback for oversized findings)
// or the payload isn't valid JSON. Callers validate the result — a prior run may predate the shape.
export const parseFindingsMarker = (body: string): unknown => {
  const b64 = /<!-- code-review:findings-json;base64 ([A-Za-z0-9+/=]+) -->/.exec(body)?.[1];
  if (b64 === undefined) return null;
  return decodeBase64Json(b64) ?? null;
};

// Per-full-review-round records (severity counts + mechanism-frequency map), carried in a base64
// marker so each completed full review appends its own and the sticky renders the convergence
// trajectory and the advisory scope-metastasis note. A CI-fix mechanic pass carries it forward
// unchanged (it is not a review round). Best-effort like the findings marker: any non-conforming
// shape decodes to no history rather than throwing on this render path.
const ROUNDS_RE = /<!-- code-review:rounds;base64 ([A-Za-z0-9+/=]+) -->/;

// The severity keys in descending weight/emphasis order, so every surface (counts validation, chips)
// iterates them the same way from one source.
const SEVERITIES = ["critical", "major", "minor", "nit"] as const;

// Non-negative integers only: a crafted/corrupted marker with a negative count would render as a
// false "clean" chip (filtered by `> 0`), and a fractional/huge one as a garbage chip. Rejecting them
// here drops the bad round instead of carrying it forward on every re-serialize.
const isSeverityCounts = (u: unknown): u is SeverityCounts =>
  typeof u === "object" &&
  u !== null &&
  SEVERITIES.every((k) => {
    const v = (u as Record<string, unknown>)[k];
    // isSafeInteger (not isInteger): a huge integer-valued float like 1e308 is an integer per
    // Number.isInteger, and would render a garbage `🔴1e+308` chip and re-serialize forward.
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  });

// How many distinct mechanisms (codes) a round's marker may record — a per-round top-N by count, so a
// finding-heavy round can't grow the carried marker without bound. Recurring mechanisms are typically
// among a round's most-counted codes, so the streak signal survives the cap.
export const MAX_CODES_PER_ROUND = 8;

// Own-property presence of a code in a frequency map. Reviewer-supplied codes are used as plain-object
// keys, so a code like "constructor" or "__proto__" must never read an inherited Object.prototype
// member (which would count a function as a recurrence). Maps are built via Object.fromEntries
// (CreateDataProperty), so the own property is what every consumer should read.
const hasCode = (codes: CodeCounts | undefined, code: string): boolean =>
  codes !== undefined && Object.prototype.hasOwnProperty.call(codes, code);

// Codes render inside backticks in the advisory notes; a backtick inside a (reviewer-supplied) code
// would break the span, and a newline would break out of the note's blockquote, so both are escaped
// (newlines collapse to a space). Shared with render.ts (which escapes paths into backtick spans) so
// the escaping rule lives in one place.
export const escapeCodeBackticks = (code: string): string =>
  code.replace(/`/g, "-").replace(/\r?\n/g, " ");

// The codes field of a round record, validated and capped: string → positive safe-integer counts only
// (a count-0 entry means "no findings this round" and is not recorded — every consumer agrees that 0
// is absence), kept sorted by count descending with ties preferring codes that recurred in the
// previous round (so the per-round top-N cap can't silently drop the exact mechanism the streak
// detector is watching), then alphabetically for a stable order. Malformed (or absent) codes decode to
// undefined so the round's severity counts still stand — a crafted marker can't smuggle a bad codes
// shape into the streak/note renderers.
const normalizeCodeCounts = (codes: unknown, priorCodes?: CodeCounts): CodeCounts | undefined => {
  if (typeof codes !== "object" || codes === null || Array.isArray(codes)) return undefined;
  const entries = Object.entries(codes as Record<string, unknown>)
    .filter(
      (e): e is [string, number] =>
        typeof e[1] === "number" && Number.isSafeInteger(e[1]) && e[1] > 0,
    )
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const aPrior = hasCode(priorCodes, a[0]) ? 1 : 0;
      const bPrior = hasCode(priorCodes, b[0]) ? 1 : 0;
      if (aPrior !== bPrior) return bPrior - aPrior;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
  if (entries.length === 0) return undefined;
  const sorted = entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const aPrior = hasCode(priorCodes, a[0]) ? 1 : 0;
    const bPrior = hasCode(priorCodes, b[0]) ? 1 : 0;
    if (aPrior !== bPrior) return bPrior - aPrior;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  // The base cap is the top-N by (count, prior-preference). A mechanism the streak detector is
  // watching (it recurred in the previous round) is never dropped by a finding-heavy round even when
  // its count is low — any such code cut by the cap is appended after the base (bounded by a second
  // cap), so a recurrence can't silently end.
  const base = sorted.slice(0, MAX_CODES_PER_ROUND);
  const priorKept = sorted
    .slice(MAX_CODES_PER_ROUND)
    .filter(([code]) => hasCode(priorCodes, code))
    .slice(0, MAX_CODES_PER_ROUND);
  return Object.fromEntries([...base, ...priorKept]);
};

export const parseRounds = (body: string): readonly RoundRecord[] => {
  const b64 = ROUNDS_RE.exec(body)?.[1];
  if (b64 === undefined) return [];
  const decoded = decodeBase64Json(b64);
  // Filter, not all-or-nothing: one future-shaped or corrupted round drops only itself rather than
  // erasing the whole trajectory (post re-serializes the parsed array on every write). The codes
  // field is normalized independently — a bad codes shape strips just that field, never the round.
  if (!Array.isArray(decoded)) return [];
  // SEQUENTIAL normalization: each round's codes are re-normalized with the PRECEDING round's
  // normalized codes as priorCodes — the same prior-kept pass roundRecord performed in memory — so
  // the up-to-8 prior-kept codes of a finding-heavy round survive the marker round-trip (without
  // it, the re-parse collapses every round to its top-8 base and the re-attached scope_metastasis
  // under-reports mechanisms post() would have flagged, issue #150 review r2).
  const kept: RoundRecord[] = [];
  let priorCodes: CodeCounts | undefined;
  for (const u of (decoded as readonly unknown[]).filter(isSeverityCounts)) {
    const rec = u as Record<string, unknown>;
    const codes = normalizeCodeCounts(rec["codes"], priorCodes);
    priorCodes = codes;
    const sha = rec["sha"];
    const shaStr = typeof sha === "string" && sha !== "" ? sha : undefined;
    const round = rec["round"];
    const roundNum =
      typeof round === "number" && Number.isSafeInteger(round) && round >= 1 ? round : undefined;
    const base =
      codes === undefined
        ? { critical: u.critical, major: u.major, minor: u.minor, nit: u.nit }
        : { critical: u.critical, major: u.major, minor: u.minor, nit: u.nit, codes };
    const record = shaStr === undefined ? base : { ...base, sha: shaStr };
    kept.push(roundNum === undefined ? record : { ...record, round: roundNum });
  }
  return kept;
};

// The rounds marker's base64 length cap. The severity counts (the trajectory) always survive; when a
// very long PR's mechanism-frequency maps would push the marker past the cap, the OLDEST rounds are
// re-serialized count-only first — so the marker stays bounded while keeping the full mechanism
// history for typical PRs. Safe because both the streak detector and the same-root annotator read
// from the END of the history; a code whose only occurrence is older than the degradation point loses
// its annotation only on an extreme (cap-exceeding) PR — the accepted boundedness tradeoff.
const ROUNDS_MARKER_LIMIT = 8000;
export const roundsMarker = (rounds: readonly RoundRecord[]): string => {
  if (rounds.length === 0) return "";
  const serialize = (kept: readonly RoundRecord[]): string =>
    `<!-- code-review:rounds;base64 ${Buffer.from(JSON.stringify(kept), "utf-8").toString("base64")} -->`;
  const stripCodes = (n: number): readonly RoundRecord[] =>
    rounds.map((r, i) =>
      i < n ? { critical: r.critical, major: r.major, minor: r.minor, nit: r.nit } : r,
    );
  // Stage 1: strip the codes+sha from the oldest rounds, oldest first, until the marker fits — the
  // severity counts (the trajectory) always survive.
  let stripped = 0;
  while (stripped < rounds.length && serialize(stripCodes(stripped)).length > ROUNDS_MARKER_LIMIT) {
    stripped += 1;
  }
  const kept = stripCodes(stripped);
  // Stage 2: even count-only, a very long history can still exceed the cap — keep only the most
  // recent rounds (the trajectory label uses the true count via the carried signal, so eliding
  // entries never falsifies the round number).
  const bounded = serialize(kept).length > ROUNDS_MARKER_LIMIT ? kept.slice(-8) : kept;
  return serialize(bounded);
};

// One round's chip: "🔴4 🟠3" for the round's severity content (findings + systemic, as stored), or
// "clean" for none.
const roundChip = (c: SeverityCounts): string => {
  const parts = SEVERITIES.filter((k) => c[k] > 0).map((k) => `${severityEmoji(k)}${String(c[k])}`);
  return parts.length === 0 ? "clean" : parts.join(" ");
};

// The convergence line: "**Round 3** · 🔴4 🟠3 → 🟠2 → clean"; "" when there is no round history. The
// round number is always the true count; the trajectory shows only the most recent chips (with a
// leading "…" when older ones are elided) so a long-running PR's line stays readable and bounded.
const TRAJECTORY_CHIPS = 8;
export const roundsSummary = (
  rounds: readonly SeverityCounts[],
  count: number = rounds.length,
): string => {
  if (count === 0) return "";
  const chips = rounds.slice(-TRAJECTORY_CHIPS).map(roundChip);
  // Every marker entry filtered (a corrupt history) still shows the round number the carried signal
  // claims — the label survives even with no chips to render (issue #141 review r4).
  const trajectory =
    chips.length === 0
      ? ""
      : rounds.length > TRAJECTORY_CHIPS
        ? `… → ${chips.join(" → ")}`
        : chips.join(" → ");
  return trajectory === ""
    ? `**Round ${String(count)}**`
    : `**Round ${String(count)}** · ${trajectory}`;
};

// The per-round mechanism-frequency map: each finding carrying a `code` counts once toward that
// mechanism, as does each code a systemic problem ties together via `finding_codes` — so a structural
// mechanism surfaced as a systemic problem is visible to the same-root note and the streak detector,
// not just one surfaced on a finding. Findings without a `code` are mechanism-unknown and uncounted.
// Built via Object.fromEntries so reviewer-supplied keys like "__proto__" or "constructor" become own
// data properties rather than mutating the map's prototype or reading inherited members.
export const computeCodeCounts = (
  findings: readonly Finding[],
  systemic: readonly SystemicProblem[] = [],
): CodeCounts => {
  // A single Map pass — one increment per code — then Object.fromEntries so a reviewer-supplied
  // key like "__proto__" becomes an own property, never the map's prototype.
  const counts = new Map<string, number>();
  for (const code of [
    ...findings.map((f) => f.code),
    ...systemic.flatMap((s) => [s.code, ...(s.finding_codes ?? [])]),
  ]) {
    if (code === undefined || code === "") continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
};

// The enriched round entry post() appends: the severity counts plus the round's code-frequency map
// (capped with a preference for codes that recurred in the previous round, so the cap can't drop a
// watched mechanism) and the reviewed head SHA. Omitting the codes field entirely when no finding
// carried a code keeps a coded-less round byte-identical to the pre-feature marker shape.
export const roundRecord = (
  counts: SeverityCounts,
  codes: CodeCounts,
  priorCodes?: CodeCounts,
  sha?: string,
  round?: number,
): RoundRecord => {
  const normalized = normalizeCodeCounts(codes, priorCodes);
  const record: RoundRecord =
    normalized === undefined ? { ...counts } : { ...counts, codes: normalized };
  return {
    ...record,
    ...(sha !== undefined ? { sha } : {}),
    ...(round !== undefined ? { round } : {}),
  };
};

// Per code, how many consecutive rounds (ending at the last recorded round) carried a finding with
// that code, and the 1-indexed round where the streak began. A round with no codes record (pre-feature
// or a round with no coded findings) ENDS every streak — absence of data cannot evidence recurrence.
export const consecutiveCodeStreaks = (
  rounds: readonly RoundRecord[],
): Readonly<Record<string, CodeStreak>> => {
  const entries: [string, CodeStreak][] = [];
  if (rounds.length === 0) return {};
  const lastCodes = rounds[rounds.length - 1]?.codes;
  if (lastCodes === undefined) return {};
  for (const code of Object.keys(lastCodes)) {
    let streak = 0;
    let startIndex = rounds.length;
    for (let i = rounds.length - 1; i >= 0; i--) {
      const codes = rounds[i]?.codes;
      if (codes === undefined || !hasCode(codes, code)) break;
      // A same-head CI retry appends a round with the same sha as the round before it — the same
      // review iteration re-examined, not new evidence of recurrence — so it neither advances nor
      // breaks the streak. Only when the code ALSO appeared in the previous (same-sha) round is the
      // evidence genuinely repeated; a code NEW in the retry round is fresh and counts.
      if (
        i > 0 &&
        rounds[i]?.sha !== undefined &&
        rounds[i]?.sha === rounds[i - 1]?.sha &&
        hasCode(rounds[i - 1]?.codes, code)
      ) {
        continue;
      }
      streak += 1;
      startIndex = i;
    }
    if (streak > 0) {
      entries.push([code, { streak, startRound: rounds[startIndex]?.round ?? startIndex + 1 }]);
    }
  }
  // Object.fromEntries so a reviewer-supplied code like "__proto__" becomes an own key, never the
  // map's prototype (which would corrupt the result and render [object Object] in the note).
  return Object.fromEntries(entries);
};

// The minimum consecutive-round recurrence that triggers the advisory scope-metastasis note.
export const DEFAULT_METASTASIS_STREAK = 3;

// The decision prompt the structured scope-metastasis entry carries (issue #150): a DECISION, not a
// directive — the issue's author-agent found "narrow the scope" would have been the wrong instruction
// on salix#100 (the metastasis converged to the correct end state), so the prompt must force an
// explicit choice, not steer one. Shared by the structured entry; the prose note paraphrases it
// (advisory-only wording, no imperative).
export const SCOPE_METASTASIS_DECISION_PROMPT =
  "Findings keep recurring in the same mechanism across consecutive rounds — each fix keeps enabling the next finding in that machinery. This is a decision, not a directive: state in your summary whether you are committing to the expanding scope (plan the remaining facets of the recurring mechanism(s) above as one unit) or narrowing the scope so the recurrence stops.";

// The codes whose consecutive-round streak meets the threshold, sorted by streak descending — the
// single computation both the advisory prose note and the structured scope-metastasis entry derive
// from, so the two surfaces can never disagree on what is flagged.
const flaggedCodeStreaks = (
  rounds: readonly RoundRecord[],
  minStreak: number,
): ReadonlyArray<{ readonly code: string; readonly streak: CodeStreak }> =>
  Object.entries(consecutiveCodeStreaks(rounds))
    .filter(([, s]) => s.streak >= minStreak)
    .sort((a, b) => b[1].streak - a[1].streak)
    .map(([code, streak]) => ({ code, streak }));

// The advisory scope-metastasis note for the sticky's convergence area: "" when no code has recurred
// in `minStreak` or more consecutive rounds. Names the mechanism by its code (the pipeline cannot
// paraphrase it — that needs the finding text) and the round range it streaked over. ADVISORY ONLY —
// mirrors the convergence badge's posture: derives from the reviewer's own codes and never alters any
// finding's severity or the verdict.
export const metastasisNote = (
  rounds: readonly RoundRecord[],
  minStreak: number = DEFAULT_METASTASIS_STREAK,
): string => {
  const flagged = flaggedCodeStreaks(rounds, minStreak);
  if (flagged.length === 0) return "";
  // The note only fires at minStreak ≥ 3 (the default), so "consecutive rounds" is always plural.
  // The round range is deliberately omitted: the history may contain same-sha retries that the
  // streak detector de-duplicates, so any X–Y range would contradict the streak count.
  const lines = flagged.map(
    ({ code, streak }) =>
      `> **\`${escapeCodeBackticks(code)}\`** — findings in ${String(streak.streak)} consecutive rounds.`,
  );
  return [
    "> [!WARNING]",
    "> **Scope metastasis** — findings keep recurring in the same mechanism across consecutive rounds; each fix keeps enabling the next finding in that machinery. Consider whether a structural fix (change the shape, not the edge case) or a scope narrowing would converge this faster.",
    ...lines,
  ].join("\n");
};

// The structured counterpart of the prose note (issue #150): the per-code consecutive-round counts
// plus the decision prompt. The re-review seed re-derives this from the carried rounds history and
// delivers it to the next-round agent (it is NOT embedded in the findings blob), so the machine
// channel and the sticky's prose carry the same recurrence signal. null when nothing is flagged, so a
// clean history carries no signal (the same omission semantics as the prose note's ""). The
// structured entry carries the RAW reviewer-supplied code (the identifier consumers match on); the
// prose note renders the SANITIZED form (escapeCodeBackticks) — the flagged SET is identical, only
// the representation differs (a backtick/newline code is escaped for the markdown surface, raw in
// the JSON).
export const computeScopeMetastasis = (
  rounds: readonly RoundRecord[],
  minStreak: number = DEFAULT_METASTASIS_STREAK,
): ScopeMetastasis | null => {
  const flagged = flaggedCodeStreaks(rounds, minStreak);
  if (flagged.length === 0) return null;
  return {
    decision_prompt: SCOPE_METASTASIS_DECISION_PROMPT,
    recurring: flagged.map(({ code, streak }) => ({
      code,
      consecutive_rounds: streak.streak,
      start_round: streak.startRound,
    })),
  };
};

// Code → "same mechanism as round N" for findings whose mechanism recurred in a PRIOR round: the most
// recent prior round that carried a finding with the same code. The deterministic backstop to the
// reviewer's own prose — the pipeline can't name the mechanism (that needs the finding text), but it
// can name the round the code last appeared in. Empty when nothing recurs.
export const computeSameRootNotes = (
  priorRounds: readonly RoundRecord[],
  findings: readonly Finding[],
  currentSha?: string,
): Readonly<Record<string, string>> => {
  const codes = findings.map((f) => f.code).filter((c): c is string => c !== undefined && c !== "");
  const entries: [string, string][] = [];
  for (const code of codes) {
    let lastRound = 0;
    for (let i = priorRounds.length - 1; i >= 0; i--) {
      // A same-sha prior round is the same commit re-reviewed (a CI retry) — its findings are the
      // same evidence, not a prior fix that re-opened the mechanism, so it must not be named. A
      // retry deeper in the history (a round that merely re-examines the commit before it) is
      // collapsed the same way consecutiveCodeStreaks collapses it, so both advisory signals agree.
      if (currentSha !== undefined && priorRounds[i]?.sha === currentSha) continue;
      // Collapse a same-sha retry exactly like consecutiveCodeStreaks does: only when the code ALSO
      // appeared in the retried round is the evidence genuinely repeated — a code NEW in the retry
      // round is fresh and is named here (the two advisory signals agree).
      if (
        i > 0 &&
        priorRounds[i]?.sha !== undefined &&
        priorRounds[i]?.sha === priorRounds[i - 1]?.sha &&
        hasCode(priorRounds[i - 1]?.codes, code)
      )
        continue;
      const count = priorRounds[i]?.codes?.[code];
      if (count !== undefined && count > 0) {
        lastRound = priorRounds[i]?.round ?? i + 1;
        break;
      }
    }
    if (lastRound > 0) {
      entries.push([
        code,
        `Same mechanism as round ${String(lastRound)} (\`${escapeCodeBackticks(code)}\`) — the prior fix in this area re-opened it; consider a structural fix or a scope narrowing.`,
      ]);
    }
  }
  // Object.fromEntries so a reviewer-supplied code like "__proto__" becomes an own key.
  return Object.fromEntries(entries);
};

// The convergence score and its advisory badge (score ≤ threshold), per finding/systemic problem:
// floor(severity) + max(0, ceiling − floor) × confidence × likelihood. The floor is the weight the
// modulation cannot erode; critical's is threshold-relative (CRITICAL_FLOOR_MARGIN) so an open critical
// is never converged at any practical threshold (the margin degrades only where FP precision drops
// 0.01, i.e. thresholds ≳ 1e14). ADVISORY ONLY: never alters the verdict.
const CONVERGENCE_CEILINGS: SeverityCounts = { critical: 4, major: 2, minor: 1, nit: 0 };
// > 0 so a lone critical fails `score ≤ threshold`; 0.01 survives round2 (a coarser round would erase it).
const CRITICAL_FLOOR_MARGIN = 0.01;
export const DEFAULT_CONVERGENCE_THRESHOLD = 1;

const convergenceFloor = (severity: Severity, threshold: number): number =>
  severity === "critical" ? threshold + CRITICAL_FLOOR_MARGIN : severity === "major" ? 0.5 : 0;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// Findings AND systemic problems (issue #134 scope), rounded to 2 decimals.
export const convergenceScore = (doc: Findings, threshold: number): number =>
  round2(
    [...doc.findings, ...(doc.systemic_problems ?? [])].reduce(
      (sum, { severity, confidence, likelihood }) => {
        const floor = convergenceFloor(severity, threshold);
        return (
          sum +
          floor +
          Math.max(0, CONVERGENCE_CEILINGS[severity] - floor) * confidence * likelihood
        );
      },
      0,
    ),
  );

// "**Convergence** 🏁 1 ≤ 1 — converged" / "**Convergence** 🔄 2 > 1 — iterating". The converged glyph
// is a checkered flag, NOT the verdict badge's ✅, so a reader (or the author-agent this steers) can't
// skim the line as an approval. The score is already rounded to 2 decimals (convergenceScore) and
// printed with String() — never re-rounded here — and the `converged` boolean reads that SAME rounded
// value, so the shown inequality can never contradict the computed comparison. The verdict derives from
// convergenceSignal — the same `score <= threshold` decision the compact signal marker's literal
// `converged` uses — so the prose badge and the machine boolean can never disagree.
export const convergenceSummary = (
  doc: Findings,
  threshold: number = DEFAULT_CONVERGENCE_THRESHOLD,
): string => {
  const { score, converged } = convergenceSignal(doc, threshold);
  return converged
    ? `**Convergence** 🏁 ${String(score)} ≤ ${String(threshold)} — converged`
    : `**Convergence** 🔄 ${String(score)} > ${String(threshold)} — iterating`;
};

// The version the compact stop-signal marker declares (signalMarker stamps it into that marker's
// payload) and the version a LEGACY surfaced blob declared before issue #156 deleted the surfacing
// transform. DISTINCT from the draft axis (DEFAULT_SCHEMA_VERSION is 0.9.0 after issue #163) so the
// surface channel can never be mistaken for the agent's own document: parseSurfaceSignal accepts a
// signal marker only at a surface version, and stripSurfaceFields recognizes a legacy surfaced blob
// by it to peel that blob back to a draft. Post-#156 nothing stamps a surfaced findings DOCUMENT —
// the embedded blob is the agent's raw draft — but the signal marker still carries this version.
export const SURFACE_SCHEMA_VERSION = "0.8.0";

export interface ConvergenceSignal {
  readonly score: number;
  readonly threshold: number;
  readonly converged: boolean;
}

// The stop signal carried in the compact signal marker: the round number + that round's score/
// threshold/converged. Computed once when the round completes; every later post carries it VERBATIM,
// never re-derived — re-deriving at a changed convergence_threshold would flip a prior round's `converged`.
export interface SurfaceSignal {
  readonly round: number;
  readonly convergence: ConvergenceSignal;
}

// The pure findings→signal computation, shared by post (a completing round) and render's fallback.
export const convergenceSignal = (
  doc: Findings,
  threshold: number = DEFAULT_CONVERGENCE_THRESHOLD,
): ConvergenceSignal => {
  const score = convergenceScore(doc, threshold);
  return { score, threshold, converged: score <= threshold };
};

// The full {round, convergence} construction, shared by post (a completing round) and render's
// fallback (the round-1 / last-round cases) — one helper so every site builds the same shape.
export const signalForRound = (
  round: number,
  doc: Findings,
  threshold: number = DEFAULT_CONVERGENCE_THRESHOLD,
): SurfaceSignal => ({ round, convergence: convergenceSignal(doc, threshold) });

// The compact signal marker: the stop signal on its own, self-describing (it declares the surface
// version, so parseSurfaceSignal's version gate applies to it too). Since issue #156 it is the SOLE
// carrier of the stop signal — the findings blob is the agent's raw document and holds no signal — so
// surfacedFindingsPointer emits it beside the blob whenever a completed round's signal exists,
// including when the blob falls to the link form and when a notice carries a prior round's signal
// forward for the next post to read back.
export const signalMarker = (signal: SurfaceSignal): string =>
  `<!-- code-review:signal;base64 ${Buffer.from(
    JSON.stringify({ schema_version: SURFACE_SCHEMA_VERSION, ...signal }),
    "utf-8",
  ).toString("base64")} -->`;

// The single join policy both post-time callers use to place the compact signal marker beside a base
// marker: it stands alone when the base is empty (an omitted blob), else rides the line below it.
export const joinSignalMarker = (base: string, marker: string): string =>
  base === "" ? marker : `${base}\n${marker}`;

// The findings blob plus the stop signal — one helper so the sticky, the review body, and the
// standalone render can never disagree on what is emitted. The blob is the agent's complete document
// (issue #156); the stop signal always rides the compact marker beside it, so an oversized review
// that falls to the link form (or is dropped) still surfaces its signal for later posts to carry.
export const surfacedFindingsPointer = (
  findings: Findings,
  signal: SurfaceSignal | null,
  jsonUrl: string | undefined,
): string => {
  // The embedded blob is the agent's COMPLETE document — byte-for-byte the object render reads — with
  // NO surfacing transform to drop a field or drift from the rendered prose (issue #156: the machine
  // channel must never carry less than the comment). The stop signal and the scope-metastasis note are
  // round state, not the agent's document, so they ride the compact signal marker and the rounds
  // marker rather than a second, divergeable copy of the findings; the seed re-derives scope metastasis
  // from the carried rounds history.
  const marker = findingsPointer(findings, jsonUrl);
  return signal === null ? marker : joinSignalMarker(marker, signalMarker(signal));
};

const SIGNAL_RE = /<!-- code-review:signal;base64 ([A-Za-z0-9+/=]+) -->/;

// The stop signal from the compact marker that rides beside every completed round's findings blob
// (issue #156) — the primary reader; parseSurfaceSignal below is the legacy fallback for pre-#156
// stickies whose signal rode inside the blob.
export const parseSignalMarker = (body: string): SurfaceSignal | null => {
  const b64 = SIGNAL_RE.exec(body)?.[1];
  if (b64 === undefined) return null;
  return parseSurfaceSignal(decodeBase64Json(b64));
};

// Best-effort like parseRounds: the carried stop signal read back from a LEGACY (pre-#156) surfaced
// blob whose signal rode inside the findings JSON — null on any malformed shape, a pre-surface blob,
// or a doc that does not declare a surfaced version, so a draft or foreign document carrying
// round/convergence keys can never be treated as the commenter's stop signal (the same version gate
// stripSurfaceFields applies to the seed channel). Post-#156 a fresh signal rides the compact marker
// (parseSignalMarker); this is reached only as findingsMarkerFor's fallback for an older sticky.
export const parseSurfaceSignal = (doc: unknown): SurfaceSignal | null => {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  if (!isSurfaceVersion(o["schema_version"])) return null;
  const round = o["round"];
  const convergence = o["convergence"];
  if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1) return null;
  if (typeof convergence !== "object" || convergence === null) return null;
  const c = convergence as Record<string, unknown>;
  // isFinite (not just typeof): JSON.parse("1e400") yields Infinity, which typeof says is a number
  // but JSON.stringify coerces to null — a non-finite score would survive one hop and then silently
  // drop the whole carried signal on the next.
  if (
    typeof c["score"] !== "number" ||
    !Number.isFinite(c["score"]) ||
    typeof c["threshold"] !== "number" ||
    !Number.isFinite(c["threshold"]) ||
    typeof c["converged"] !== "boolean"
  ) {
    return null;
  }
  return {
    round,
    convergence: { score: c["score"], threshold: c["threshold"], converged: c["converged"] },
  };
};

// Every surface-channel version this CLI recognizes: the versions a LEGACY surfaced blob declared
// (which stripSurfaceFields peels back to the agent document, so a sticky written before issue #156
// still seeds) plus the version the compact signal marker declares today. A dedicated list,
// deliberately distinct from the draft-version registry axis: only these versions declare the surface
// channel, so a draft bump can never be mistaken for one. A future surface bump appends the
// superseded version(s) here alongside the new one.
export const SURFACE_SCHEMA_VERSIONS: readonly string[] = ["0.7.0", SURFACE_SCHEMA_VERSION];

// Does a value declare one of the surface-channel versions? The single gate the surface channel
// applies wherever it must tell a commenter-side surface artifact from the agent's own draft — the
// stop-signal read-back (parseSurfaceSignal), the legacy-blob peel-back (stripSurfaceFields), and the
// seed's authoritative-vs-echoed scope_metastasis decision all share it.
export const isSurfaceVersion = (version: unknown): boolean =>
  typeof version === "string" && SURFACE_SCHEMA_VERSIONS.includes(version);

// Peels a LEGACY surfaced blob (pre-#156) back to the agent's own document for the re-review seed —
// post-#156 a fresh blob is already the agent's draft and passes through untouched. Version-gated,
// not key-gated: a doc declaring a known SURFACE version has its pipeline-stamped convergence/round
// dropped and its version restored to the current draft default, so the seeded draft still validates;
// anything else (a draft version, an unknown future version, a malformed version) passes through
// untouched and fails or passes schema validation downstream on its own merits — never silently
// rewritten. A non-object stays as-is. A legacy blob's `scope_metastasis` (issue #150) is NOT dropped
// here: on a 0.8.0 surfaced blob it was pipeline-stamped and authoritative, so it must reach the
// next-round agent (a 0.7.0 blob predates the field; the draft schema tolerates it so the seeded doc
// validates); a draft blob's echoed entry is dropped upstream in the seed, before this runs.
export const stripSurfaceFields = (doc: unknown): unknown => {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return doc;
  const o = doc as Record<string, unknown>;
  if (!isSurfaceVersion(o["schema_version"])) return doc;
  const rest = Object.fromEntries(
    Object.entries(o).filter(([key]) => key !== "convergence" && key !== "round"),
  );
  return { ...rest, schema_version: DEFAULT_SCHEMA_VERSION };
};

// The machine-readable markers to carry forward when a comment's PROSE is replaced but its data must
// survive — the "review in progress" placeholder swaps the visible summary yet must not clobber the
// re-review seed the review job reads back from the sticky (the embedded findings + reviewed-sha),
// the route that made the seed chain route-aware, nor the round-history trajectory. The findings
// marker is extracted verbatim so both its base64 and jsonUrl-link forms survive; base64 (A–Z a–z
// 0–9 + / =) and URLs never contain '>', so `[^>]*` stops at its closing `-->`. The STOP directive
// that always precedes it is re-emitted from AGENTS_STOP_DIRECTIVE (its SSOT above) rather than
// re-matched, so a future edit to that constant can't silently desync a parallel regex. Returns ""
// when the body carries none of them.
export const carryForwardMarkers = (body: string): string => {
  const findings = /<!-- code-review:findings-json[^>]*-->/.exec(body)?.[0];
  const reviewedSha = /<!-- reviewed-sha: [0-9a-fA-F]{40} -->/.exec(body)?.[0];
  const reviewedRoute = ROUTE_RE.exec(body)?.[0];
  const rounds = ROUNDS_RE.exec(body)?.[0];
  const signal = SIGNAL_RE.exec(body)?.[0];
  // The replaced sticky was a completed review — the placeholder must record that ancestry even
  // though review-complete itself is never carried (it would read as a finished review).
  const completedAncestor =
    parseReviewComplete(body) || parseCompletedAncestor(body)
      ? COMPLETED_ANCESTOR_MARKER
      : undefined;
  const findingsBlock = findings ? `${AGENTS_STOP_DIRECTIVE}\n${findings}` : undefined;
  return [findingsBlock, reviewedSha, reviewedRoute, completedAncestor, rounds, signal]
    .filter((m): m is string => m !== undefined)
    .join("\n\n");
};

// Escape triple-backticks so fenced content can't break out of its block.
const escapeFence = (text: string): string => text.replace(/```/g, "`` ` ``");

// A GitHub ```suggestion when the patch lowers to replacement text, a non-lossy ```patch fallback
// when it can't, or nothing when the finding carries no patch.
export type PatchProjection =
  | { readonly kind: "suggestion"; readonly text: string }
  | { readonly kind: "patch"; readonly raw: string }
  | { readonly kind: "none" };

export const projectPatch = (patch: string | undefined): PatchProjection => {
  if (patch === undefined) return { kind: "none" };
  const lowered = patchToSuggestion(patch);
  return typeof lowered === "string"
    ? { kind: "suggestion", text: escapeFence(lowered) }
    : { kind: "patch", raw: escapeFence(patch) };
};

export const formatConfidence = (n: number): string => n.toFixed(2);

// The review-object body: a bare one-line pointer to the sticky, where the findings-json blob lives —
// the sole documented decode surface (issue #161). It never embeds the blob: the review body is written
// only after upsertSticky returns (a genuinely failed sticky write throws and aborts post() first), so
// the sticky always exists to carry the machine channel by the time this renders. SSOT shared by the
// commenter (post.ts) and the `preview` command.
export const reviewBodyPointer = (headSha: string, stickyUrl: string | undefined): string => {
  const sha7 = headSha.slice(0, 7);
  return stickyUrl
    ? `🤖 Automated code review for \`${sha7}\` — see the [summary comment](${stickyUrl}) for the verdict, walkthrough, and cost.`
    : `🤖 Automated code review for \`${sha7}\` — see the summary comment for the verdict, walkthrough, and cost.`;
};
