// Single source of truth for the bits every render surface (sticky, inline comment, review body)
// must agree on: severity→emoji, the machine-readable findings-json marker, and patch→suggestion
// projection. Pure.

import { ConvergenceCodec, DEFAULT_SCHEMA_VERSION } from "./schema.js";
import type {
  ChangeSize,
  Convergence,
  ConvergenceCore,
  ConvergenceRound,
  Finding,
  Findings,
  ScopeMetastasis,
  Severity,
  SystemicProblem,
} from "./schema.js";
import type { CodeCounts, CodeStreak, RoundRecord, SeverityCounts } from "./types.js";
import { patchToSuggestion } from "./patch.js";

// The recurrence signals (streaks, scope metastasis, same-root) read only a round's mechanism map,
// head SHA, and round number — never its score or severity counts — so this structural shape lets both
// the JSON trajectory (ConvergenceRound) and a legacy parsed rounds marker (RoundRecord) flow through
// the same detectors without an adapter.
type RecurrenceRound = {
  readonly codes?: CodeCounts;
  readonly sha?: string;
  readonly round?: number;
};

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

// ~32KB of JSON in base64 — well under GitHub's 65536-char comment limit. The embedded blob is the
// agent's COMPLETE document plus the pipeline-stamped `convergence` field (issue #174), all in one JSON
// object; scope_metastasis is re-derived at seed time rather than carried. The value is kept at the
// pre-#156 boundary as a deliberate backward-compat margin, so every review that embedded before the
// surfacing transform was deleted still embeds. When a review DOES exceed this and the blob falls to the
// link form, the convergence rides its own compact `code-review:convergence` marker beside the link
// (issue #185 review) — a size fallback carrying the SAME stamped object — so the trajectory and stop
// signal survive; only the re-review FINDINGS seed degrades (a decoder must fetch the linked artifact
// for the findings). The AGENTS_STOP_DIRECTIVE (~1.1KB, issues #171 + #217) rides ahead of the marker on every
// surface, a small fraction of the headroom.
export const EMBED_LIMIT = 42700;

// The canonical location of the findings schema — the moving `main` ref (mirrors findings.schema.json's
// own $id). No version tag is cut yet; a tagged schema pins its own $id (schema/VERSIONING.md), so a
// decoding agent starts here and, if its document's schema_version names a different version, fetches
// that one — the URL below is NOT version-pinned.
const FINDINGS_SCHEMA_URL =
  "https://raw.githubusercontent.com/JPHutchins/code-review/main/schema/findings.schema.json";

// Travels with the marker on every surface, so it must be true on every surface — including the ones
// whose prose is a STATUS line (the in-progress placeholder, the did-not-complete notice, the
// empty-diff notice), where the marker is the only copy of the last real review and decoding is the
// right action. That is why the directive is conditional rather than a flat "read the prose": the
// same constant rides a rendered review and a one-line status, and telling an agent to read the prose
// on the latter loses the review (issues #171, #217). Uses em dashes, never "--", so the HTML comment
// stays well-formed. Exported so the surfaces and their tests share one SSOT for the text (it is
// carried forward verbatim by carryForwardMarkers) — the text below is that SSOT; do not restate it
// here.
export const AGENTS_STOP_DIRECTIVE = `<!-- AGENTS: STOP — when this comment renders a review, read that: the prose carries the summary, every finding with its severity, confidence and likelihood, the systemic problems, the convergence score with its threshold and per-round trajectory, and the cost, and it is the cheaper read. Decode the marker below when you need what the prose leaves out by design — the below-visibility-floor nits, each finding's stable code, the per-round recurrence signals — or when this comment renders a STATUS line rather than a review: there the marker is the only copy of the last real review, and decoding it is the correct action. Two rounds this comment does not carry whole: one that anchors findings to diff lines keeps those on the diff, and one too large to embed links its findings artifact in the marker instead of carrying it. Both are rendered whole in the workflow run's summary. Read the document's schema_version and fetch the schema for THAT version before acting — a schema's own $id is its canonical URL, and the URL below is the current version, not a pinned one: ${FINDINGS_SCHEMA_URL} — then parse the WHOLE findings document, not only the fields you recognize. -->`;

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
  if (route === "full review") return true;
  if (route === "mechanic") return false;
  // Round history means a completed full review — whether it rides the new convergence field/marker or a
  // legacy rounds marker (issue #185 review). A post-#174 notice carries its trajectory only in the blob,
  // and this predicate gates the empty-mechanic guard that must not bury that completed review.
  return priorTrajectory(parseFindingsMarker(body), body).length > 0;
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
  const entries = Object.entries(codes as Record<string, unknown>).filter(
    (e): e is [string, number] =>
      typeof e[1] === "number" && Number.isSafeInteger(e[1]) && e[1] > 0,
  );
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
  // normalized codes as priorCodes, so the up-to-8 prior-kept codes of a finding-heavy round survive
  // the marker round-trip (without it, the re-parse collapses every round to its top-8 base and the
  // re-attached scope_metastasis under-reports mechanisms post() would have flagged, issue #150 review r2).
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

// A convergence score for display: the same fixed-2-decimal formatting as formatConfidence (a descent
// reads cleanly — 2.40 → 1.10 → 0.42 — and the badge and the trajectory's last entry print identically).
// Delegates so a future change to the 2-decimal rule lands in one place.
export const formatScore = (score: number): string => formatConfidence(score);

// The convergence trajectory (issue #174): "**Round 3** · 2.40 → 1.10 → 0.42"; "" when there is no
// round history. Each entry is a round's stored convergence score; a round with no stored score (a
// legacy rounds marker predating this feature) renders "—" rather than a severity chip, so the line
// never mixes units. The round number is always the true count; only the most recent entries show
// (with a leading "…" when older ones are elided) so a long-running PR's line stays bounded.
const TRAJECTORY_SCORES = 8;
export const roundsSummary = (
  rounds: readonly { readonly round?: number; readonly score?: number }[],
  count: number = rounds.length,
): string => {
  if (count === 0) return "";
  const cells = rounds
    .slice(-TRAJECTORY_SCORES)
    .map((r) => (typeof r.score === "number" ? formatScore(r.score) : "—"));
  const trajectory =
    cells.length === 0
      ? ""
      : rounds.length > TRAJECTORY_SCORES
        ? `… → ${cells.join(" → ")}`
        : cells.join(" → ");
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

// Per code, how many consecutive rounds (ending at the last recorded round) carried a finding with
// that code, and the 1-indexed round where the streak began. A round with no codes record (pre-feature
// or a round with no coded findings) ENDS every streak — absence of data cannot evidence recurrence.
export const consecutiveCodeStreaks = (
  rounds: readonly RecurrenceRound[],
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
  rounds: readonly RecurrenceRound[],
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
  rounds: readonly RecurrenceRound[],
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
  rounds: readonly RecurrenceRound[],
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
  priorRounds: readonly RecurrenceRound[],
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
// A minor's floor (issue #178): the weight the modulation cannot erode, so a PILE of low-likelihood
// minors resists convergence even when each is individually unlikely — count matters, not only
// per-finding likelihood. A single solid minor still converges (0.1 + 0.9 × conf × like ≤ 1).
const MINOR_FLOOR = 0.1;
export const DEFAULT_CONVERGENCE_THRESHOLD = 1;

const convergenceFloor = (severity: Severity, threshold: number): number =>
  severity === "critical"
    ? threshold + CRITICAL_FLOOR_MARGIN
    : severity === "major"
      ? 0.5
      : severity === "minor"
        ? MINOR_FLOOR
        : 0;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// One finding/systemic-problem's contribution: floor(severity) + confidence-and-likelihood-weighted
// headroom. The interlocks live HERE so both reducers below share them: max(0, …) can't invert when
// threshold ≥ ceiling, and the critical margin + round2 preserve an open critical's `> threshold`
// guarantee.
const contribution = (
  severity: Severity,
  confidence: number,
  likelihood: number,
  threshold: number,
): number => {
  const floor = convergenceFloor(severity, threshold);
  return floor + Math.max(0, CONVERGENCE_CEILINGS[severity] - floor) * confidence * likelihood;
};

// Findings AND systemic problems (issue #134 scope), rounded to 2 decimals. A systemic problem is
// scored with likelihood 1, NEVER its written value (issue #178): `likelihood` measures how routinely a
// triggering input/state occurs, but a structural/cross-cutting observation has no single triggering
// input — it is definitionally always present — so discounting it by likelihood is a category error
// that under-weights exactly the findings that tie a review together. The field stays on the schema
// (removing it would invalidate blobs already posted) but the score does not read it for systemic.
export const convergenceScore = (doc: Findings, threshold: number): number =>
  round2(
    doc.findings.reduce(
      (sum, { severity, confidence, likelihood }) =>
        sum + contribution(severity, confidence, likelihood, threshold),
      0,
    ) +
      (doc.systemic_problems ?? []).reduce(
        (sum, { severity, confidence }) => sum + contribution(severity, confidence, 1, threshold),
        0,
      ),
  );

// The pipeline-stamped convergence field (issue #174): this round's score/threshold/converged plus the
// per-round trajectory. Prior rounds are carried VERBATIM — their scores are historical snapshots, and
// recomputing at a changed threshold would rewrite the past — while THIS round is appended with its
// score and the mechanism map + head SHA the recurrence signals read. The trajectory keeps only the
// most recent CONVERGENCE_TRAJECTORY_LIMIT rounds — a COUNT bound (not a byte cap), which keeps the blob
// growth bounded in the common case (a round record is compact) and caps the same-root memory at that
// many rounds; the recurrence detectors read only the recent tail, so bounding never ends a live streak.
export const CONVERGENCE_TRAJECTORY_LIMIT = 64;
export const buildConvergence = (
  doc: Findings,
  threshold: number = DEFAULT_CONVERGENCE_THRESHOLD,
  priorRounds: readonly ConvergenceRound[] = [],
  round: number = 1,
  codes: CodeCounts = {},
  sha?: string,
): Convergence => {
  const score = convergenceScore(doc, threshold);
  const normalized = normalizeCodeCounts(codes, priorRounds[priorRounds.length - 1]?.codes);
  const current: ConvergenceRound = {
    round,
    score,
    ...(normalized !== undefined ? { codes: { ...normalized } } : {}),
    ...(sha !== undefined ? { sha } : {}),
  };
  const rounds = [...priorRounds, current].slice(-CONVERGENCE_TRAJECTORY_LIMIT);
  return { score, threshold, converged: score <= threshold, rounds };
};

// ── Nit visibility floor (issue #164) ───────────────────────────────────────────────────────────
// A nit whose confidence × likelihood falls below this is below the noise floor: KEPT in the machine
// blob (so the next-round seed reads it as already adjudicated and never re-raises it as fresh) but
// hidden from the HUMAN surfaces (no inline comment; a collapsed aside in the sticky). Nit-only, and
// orthogonal to the convergence score — a nit's ceiling is 0, so it contributes 0 whether shown or
// hidden. Scoped to findings only; a nit-severity systemic problem is never floored here (hiding a
// cross-cutting observation is a heavier call than hiding a per-line nit).
export const DEFAULT_NIT_VISIBILITY_FLOOR = 0.25;

// True when a finding is a nit below the visibility floor. Accepts a loose shape so it serves both a
// validated current Finding (confidence/likelihood are always numbers) and a hand-parsed prior-blob
// finding: a non-numeric confidence or likelihood — a pre-0.9 blob predates likelihood — makes this
// FALSE, so a finding is never hidden on missing data; suppression fails OPEN to visible.
export const isBelowVisibilityFloor = (
  f: { readonly severity?: unknown; readonly confidence?: unknown; readonly likelihood?: unknown },
  floor: number = DEFAULT_NIT_VISIBILITY_FLOOR,
): boolean =>
  f.severity === "nit" &&
  typeof f.confidence === "number" &&
  typeof f.likelihood === "number" &&
  f.confidence * f.likelihood < floor;

// The identifying bits of a prior round's below-floor nit, hand-parsed from a decoded prior findings
// blob (parseFindingsMarker output) — the one-round suppression memory. post derives its stickiness
// key from these (a still-nit matching one stays hidden even if its score wobbled up); the seed
// delivers them as adjudicated context. Defensive/best-effort like parseRounds: a non-object, an old
// blob without likelihood, or a malformed entry contributes nothing.
export interface PriorSuppressedNit {
  readonly title: string;
  readonly code?: string;
  readonly path?: string;
}
export const priorBelowFloorNits = (
  priorDoc: unknown,
  floor: number = DEFAULT_NIT_VISIBILITY_FLOOR,
): readonly PriorSuppressedNit[] => {
  if (typeof priorDoc !== "object" || priorDoc === null) return [];
  const arr = (priorDoc as Record<string, unknown>)["findings"];
  if (!Array.isArray(arr)) return [];
  const nits: PriorSuppressedNit[] = [];
  for (const f of arr) {
    if (typeof f !== "object" || f === null) continue;
    const rec = f as Record<string, unknown>;
    if (!isBelowVisibilityFloor(rec, floor)) continue;
    const title = rec["title"];
    if (typeof title !== "string") continue;
    const code = typeof rec["code"] === "string" && rec["code"] !== "" ? rec["code"] : undefined;
    const path = typeof rec["path"] === "string" ? rec["path"] : undefined;
    nits.push({
      title,
      ...(code !== undefined ? { code } : {}),
      ...(path !== undefined ? { path } : {}),
    });
  }
  return nits;
};

// The convergence badge from a stored or freshly-computed signal: "**Convergence** 🏁 0.42 ≤ 1 —
// converged" / "**Convergence** 🔄 2.40 > 1 — iterating". The score prints 2-decimal (formatScore) so it
// matches the trajectory's last entry; the converged glyph is a checkered flag, NOT the verdict badge's
// ✅, so a reader (or the author-agent this steers) can't skim the line as an approval. `converged` is
// read from the signal, never recomputed here, so the shown inequality can't contradict the stored
// decision.
export const convergenceBadge = (c: ConvergenceCore): string =>
  c.converged
    ? `**Convergence** 🏁 ${formatScore(c.score)} ≤ ${String(c.threshold)} — converged`
    : `**Convergence** 🔄 ${formatScore(c.score)} > ${String(c.threshold)} — iterating`;

// The badge computed fresh from a document — the standalone `render` command and any legacy sticky with
// no stored convergence. The post path reads the stamped signal via convergenceBadge, so its shown
// score is the verbatim historical value.
export const convergenceSummary = (
  doc: Findings,
  threshold: number = DEFAULT_CONVERGENCE_THRESHOLD,
): string => convergenceBadge(convergenceSignal(doc, threshold));

// The change-size breakdown line (issue #182): "+240 / −80 code · +120 / −10 tests · +30 / −0 docs",
// dropping a role the agent left absent. "" when the field or every role is absent. The agent's
// best-effort role split (chrome); the per-language cloc table rides its own collapsible beside it.
export const changeSizeSummary = (changeSize: ChangeSize | undefined): string => {
  if (changeSize === undefined) return "";
  const cell = (
    label: string,
    d: { readonly added: number; readonly removed: number } | undefined,
  ): string | null =>
    d === undefined ? null : `+${String(d.added)} / −${String(d.removed)} ${label}`;
  return [
    cell("code", changeSize.code),
    cell("tests", changeSize.tests),
    cell("docs", changeSize.docs),
  ]
    .filter((c): c is string => c !== null)
    .join(" · ");
};

// The round number the NEXT completed full review will stamp, from a prior sticky's parsed state: the
// max of the trajectory and the carried convergence's last round (never regresses across a legacy
// signal/marker split), + 1. post numbers its appended round with it and announce labels the in-progress
// trajectory with it, so the placeholder's round and post's stamp are ONE derivation, not copy-paste.
export const nextRoundNumber = (
  priorTraj: readonly ConvergenceRound[],
  priorConvRounds: readonly ConvergenceRound[],
): number => {
  const last = (rounds: readonly ConvergenceRound[]): number =>
    rounds.length > 0 ? (rounds[rounds.length - 1]?.round ?? rounds.length) : 0;
  return Math.max(last(priorTraj), last(priorConvRounds)) + 1;
};

// The in-progress trajectory line for the announce placeholder (issue #180): the completed rounds'
// scores plus a pending "⏳" cell for the round now running. The caller passes the running round from
// nextRoundNumber, so the label and the pending cell agree with what post will stamp — by construction,
// not by re-derivation here. NO badge: a carried "converged" above a running round would read as "done,
// ignore this." "" when the prior carries no completed round.
export const inProgressConvergence = (prior: Convergence, runningRound: number): string => {
  const rounds = prior.rounds ?? [];
  return rounds.length === 0 ? "" : `${roundsSummary(rounds, runningRound)} → ⏳`;
};

// The version a LEGACY compact stop-signal marker declared, and the version a LEGACY surfaced blob
// declared before issue #156 deleted the surfacing transform. Its writer is retired (issue #186); the
// version survives so the migration readers recognize a pre-#185 marker. DISTINCT from the draft axis
// (DEFAULT_SCHEMA_VERSION is 0.9.0 after issue #163) so the surface channel can never be mistaken for
// the agent's own document: parseSurfaceSignal accepts a signal marker only at a surface version, and
// stripSurfaceFields recognizes a legacy surfaced blob by it to peel that blob back to a draft.
export const SURFACE_SCHEMA_VERSION = "0.8.0";

// The stop signal's convergence core is the schema's ConvergenceCore — one definition shared by the
// JSON convergence field and the legacy compact signal marker's reader.
export type ConvergenceSignal = ConvergenceCore;

// The shape parseSignalMarker / parseSurfaceSignal return from a LEGACY compact signal marker or
// surfaced blob: the round number + that round's score/threshold/converged. Its writer is retired
// (issue #186); post now carries convergence forward via the stamped field (carriedConvergence), and a
// stored `converged` is never re-derived — re-deriving at a changed convergence_threshold would flip a
// prior round's decision.
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

const SIGNAL_RE = /<!-- code-review:signal;base64 ([A-Za-z0-9+/=]+) -->/;

// Decodes a LEGACY compact signal marker (writer retired, issue #186) — a read-only fallback in the
// carry chain: carriedConvergence reads the stamped convergence field, then the code-review:convergence
// marker, and only then this. parseSurfaceSignal below is the older fallback for pre-#156 stickies whose
// signal rode inside the blob.
export const parseSignalMarker = (body: string): SurfaceSignal | null => {
  const b64 = SIGNAL_RE.exec(body)?.[1];
  if (b64 === undefined) return null;
  return parseSurfaceSignal(decodeBase64Json(b64));
};

// Best-effort like parseRounds: the carried stop signal read back from a LEGACY (pre-#156) surfaced
// blob whose signal rode inside the findings JSON — null on any malformed shape, a pre-surface blob,
// or a doc that does not declare a surfaced version, so a draft or foreign document carrying
// round/convergence keys can never be treated as the commenter's stop signal (the same version gate
// stripSurfaceFields applies to the seed channel). Nothing writes this anymore (issue #186); it is the
// last fallback in carriedConvergence's carry chain, reached only for an older sticky.
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

// Decode-tolerant read of the pipeline-stamped convergence field from a prior findings blob (the raw
// parseFindingsMarker output): the convergence when the blob carries a valid one, else null.
// Best-effort like parseRounds — a malformed or absent field yields null, never a throw.
// A #174 pipeline stamp always carries a NON-EMPTY trajectory. A convergence that decodes but has no
// `rounds` (or an empty one) is either a legacy pre-#156 surface blob's embedded stop signal or a
// crafted/reset value — treat it as absent so the marker/legacy fallbacks reconstruct the whole thing,
// and an empty trajectory can never silently reset the round count to 0 (issue #185 review).
const validStampedConvergence = (raw: unknown): Convergence | null => {
  const decoded = ConvergenceCodec.decode(raw);
  return decoded._tag === "Right" &&
    decoded.right.rounds !== undefined &&
    decoded.right.rounds.length > 0
    ? decoded.right
    : null;
};

export const parseConvergence = (priorDoc: unknown): Convergence | null => {
  if (typeof priorDoc !== "object" || priorDoc === null) return null;
  const raw = (priorDoc as Record<string, unknown>)["convergence"];
  return raw === undefined ? null : validStampedConvergence(raw);
};

const CONVERGENCE_RE = /<!-- code-review:convergence;base64 ([A-Za-z0-9+/=]+) -->/;

// The compact convergence marker — a SIZE FALLBACK for the link/omitted blob form (issue #185 review):
// convergence lives IN the findings blob (the SSOT), but an oversized review's blob falls to the link
// form and the convergence would be lost with it. This carries the SAME stamped convergence object
// compactly beside the link, emitted ONLY when the blob does not embed and read ONLY as a fallback (the
// embedded blob always wins), so a normal sticky carries no such marker and the two can never diverge.
export const convergenceMarker = (convergence: Convergence): string =>
  `<!-- code-review:convergence;base64 ${Buffer.from(JSON.stringify(convergence), "utf-8").toString(
    "base64",
  )} -->`;

export const parseConvergenceMarker = (body: string): Convergence | null => {
  const b64 = CONVERGENCE_RE.exec(body)?.[1];
  return b64 === undefined ? null : validStampedConvergence(decodeBase64Json(b64));
};

// A legacy parsed rounds marker mapped into the trajectory shape: codes/sha/round survive (the
// recurrence detectors read them), score is absent (a legacy round stored no score, so the trajectory
// renders "—" for it). The one-time bridge across the upgrade to the JSON convergence field.
export const roundRecordsToConvergenceRounds = (
  records: readonly RoundRecord[],
): ConvergenceRound[] =>
  records.map((r, i) => ({
    round: r.round ?? i + 1,
    ...(r.codes !== undefined ? { codes: { ...r.codes } } : {}),
    ...(r.sha !== undefined ? { sha: r.sha } : {}),
  }));

// The prior round trajectory for post + seed: the JSON convergence field's rounds when the prior blob
// carries it, else the legacy rounds marker mapped forward. Empty on a first review.
export const priorTrajectory = (
  priorDoc: unknown,
  priorBody: string,
): readonly ConvergenceRound[] =>
  parseConvergence(priorDoc)?.rounds ??
  parseConvergenceMarker(priorBody)?.rounds ??
  roundRecordsToConvergenceRounds(parseRounds(priorBody));

// The prior completed round's convergence, carried VERBATIM into a notice or CI-fix pass so the JSON
// keeps the trajectory + last score across a non-round post: the stamped convergence field if present,
// else reconstructed from a legacy sticky's compact signal marker (the core) + rounds marker (the
// trajectory, scoreless). null when no round has completed — a first-run notice stamps no convergence.
export const carriedConvergence = (priorDoc: unknown, priorBody: string): Convergence | null => {
  const stamped = parseConvergence(priorDoc) ?? parseConvergenceMarker(priorBody);
  if (stamped !== null) return stamped;
  const signal = parseSignalMarker(priorBody) ?? parseSurfaceSignal(priorDoc);
  if (signal === null) return null;
  const legacy = roundRecordsToConvergenceRounds(parseRounds(priorBody));
  // The legacy signal's round is the authoritative completed-round count; if a corrupt round was
  // filtered from the rounds marker, keep that count on the trajectory's last entry so the next round
  // never regresses (issue #141). An empty marker beside a signal becomes a single scoreless round.
  const last = legacy[legacy.length - 1];
  const rounds =
    last === undefined
      ? [{ round: signal.round }]
      : last.round < signal.round
        ? [...legacy.slice(0, -1), { ...last, round: signal.round }]
        : legacy;
  return { ...signal.convergence, rounds };
};

// Every surface-channel version this CLI recognizes: the versions a LEGACY surfaced blob declared
// (which stripSurfaceFields peels back to the agent document, so a sticky written before issue #156
// still seeds) plus the version a legacy compact signal marker declared. Both are read-only now (the
// writers are retired, issue #186). A dedicated list, deliberately distinct from the draft-version
// registry axis: only these versions declare the surface channel, so a draft bump can never be
// mistaken for one. A future surface bump appends the superseded version(s) here alongside the new one.
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
  // The compact convergence marker (issue #185 review) rides an oversized review's link-form blob, so
  // the in-progress placeholder must carry it forward too or the trajectory is lost across the swap.
  const convergence = CONVERGENCE_RE.exec(body)?.[0];
  const rounds = ROUNDS_RE.exec(body)?.[0];
  const signal = SIGNAL_RE.exec(body)?.[0];
  // The replaced sticky was a completed review — the placeholder must record that ancestry even
  // though review-complete itself is never carried (it would read as a finished review).
  const completedAncestor =
    parseReviewComplete(body) || parseCompletedAncestor(body)
      ? COMPLETED_ANCESTOR_MARKER
      : undefined;
  const findingsBlock = findings ? `${AGENTS_STOP_DIRECTIVE}\n${findings}` : undefined;
  return [findingsBlock, reviewedSha, reviewedRoute, completedAncestor, convergence, rounds, signal]
    .filter((m): m is string => m !== undefined)
    .join("\n\n");
};

// Escape triple-backticks so fenced content can't break out of its block.
export const escapeFence = (text: string): string => text.replace(/```/g, "`` ` ``");

// A GitHub ```suggestion when the patch lowers to replacement text, a non-lossy ```patch fallback
// when it can't, or nothing when the finding carries no patch.
export type PatchProjection =
  | { readonly kind: "suggestion"; readonly text: string }
  | { readonly kind: "patch"; readonly raw: string }
  | { readonly kind: "none" };

// GitHub renders a ```suggestion as an Apply button ONLY in a review comment anchored to diff lines.
// In an issue comment — which is what the sticky is — the same block is inert, and worse than inert:
// it shows the replacement text stripped of the lines it replaces, so the reader sees the fix with no
// indication of what it displaces. The raw patch is a hunk and reads as one, so a comment-body
// surface keeps it rather than lowering it to a suggestion that surface cannot honour. Both forms
// still go through escapeFence: a hunk that itself contains a triple backtick would otherwise close
// the block it is rendered in, so the escape is what keeps the rest of the comment intact — the
// displayed hunk is faithful except for that sequence.
export type PatchSurface = "diff-anchored" | "comment-body";

export const projectPatch = (patch: string | undefined, surface: PatchSurface): PatchProjection => {
  if (patch === undefined) return { kind: "none" };
  const lowered = surface === "diff-anchored" ? patchToSuggestion(patch) : undefined;
  return typeof lowered === "string"
    ? { kind: "suggestion", text: escapeFence(lowered) }
    : { kind: "patch", raw: escapeFence(patch) };
};

export const formatConfidence = (n: number): string => n.toFixed(2);

// The review-object body: a bare one-line pointer to the sticky, where the findings-json blob lives —
// the sole documented decode surface (issue #161) — and to the run that produced the review (issue
// #204), so a reader who lands here has a path back to the evidence. It never embeds the blob: the
// review body is written only after upsertSticky returns — a genuinely failed sticky write throws and
// aborts post() first, and a response it cannot parse leaves these words unlinked rather than
// embedding the blob here. SSOT shared by the commenter (post.ts) and the `preview` command.
// The two links degrade differently: no sticky URL leaves the words unlinked, no run URL omits the run
// sentence entirely. The run sentence names what the link is FOR rather than what the run still holds —
// retention prunes logs and artifacts while the review object persists. The run's SUMMARY is the
// review rendered whole (issue #205) — the sticky shows the latest round, the summaries show each
// round as it stood — so the sentence names it, but only when there is one: `post` run outside
// Actions writes no summary, and a pointer promising a document that was never written is worse than
// one that promises less.
export const reviewBodyPointer = (
  headSha: string,
  stickyUrl: string | undefined,
  runUrl: string | undefined,
  runHasSummary: boolean,
): string => {
  const sha7 = headSha.slice(0, 7);
  const summary = stickyUrl ? `the [summary comment](${stickyUrl})` : "the summary comment";
  const run = runUrl
    ? ` See the [workflow run](${runUrl}) for ${runHasSummary ? "this round's review in full, its job log," : "the job log"} and the findings artifact.`
    : "";
  return `🤖 Automated code review for \`${sha7}\` — see ${summary} for the verdict, walkthrough, and cost.${run}`;
};
