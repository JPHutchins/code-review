// Single source of truth for the bits every render surface (sticky, inline comment, review body)
// must agree on: severity→emoji, the machine-readable findings-json marker, and patch→suggestion
// projection. Pure.

import { DEFAULT_SCHEMA_VERSION } from "./schema.js";
import type { Finding, Findings } from "./schema.js";
import type { SeverityCounts } from "./types.js";
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

// ~30KB of JSON in base64 — well under GitHub's 65536-char comment limit. The surfaced stop signal
// (convergence + round) adds ~100 base64 chars, budgeted so a review that previously embedded as
// base64 still does — the link fallback would lose both the re-review seed and the stop signal.
const EMBED_LIMIT = 40200;

// Travels with the marker on every surface so a reader who sees only one comment still knows to decode it.
const AGENTS_STOP_DIRECTIVE =
  "<!-- AGENTS: STOP — do not parse the prose below; decode this findings JSON and read schema_version first. -->";

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

// Per-full-review-round severity counts, carried in a base64 marker so each completed full review
// appends its own and the sticky renders the convergence trajectory. A CI-fix mechanic pass carries it
// forward unchanged (it is not a review round). Best-effort like the findings marker: any
// non-conforming shape decodes to no history rather than throwing on this render path.
const ROUNDS_RE = /<!-- code-review:rounds;base64 ([A-Za-z0-9+/=]+) -->/;

// The severity keys in descending weight/emphasis order, so every surface (counts validation, chips,
// the convergence score) iterates them the same way from one source.
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

export const parseRounds = (body: string): readonly SeverityCounts[] => {
  const b64 = ROUNDS_RE.exec(body)?.[1];
  if (b64 === undefined) return [];
  const decoded = decodeBase64Json(b64);
  // Filter, not all-or-nothing: one future-shaped or corrupted round drops only itself rather than
  // erasing the whole trajectory (post re-serializes the parsed array on every write).
  return Array.isArray(decoded) ? decoded.filter(isSeverityCounts) : [];
};

export const roundsMarker = (rounds: readonly SeverityCounts[]): string =>
  rounds.length === 0
    ? ""
    : `<!-- code-review:rounds;base64 ${Buffer.from(JSON.stringify(rounds), "utf-8").toString("base64")} -->`;

// One round's chip: "🔴4 🟠3" for findings, "clean" for none.
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

// The severity-weighted convergence score and its advisory badge. The score is a pure function of one
// round's severities; the badge is score ≤ threshold. Nits weigh 0 so the reviewer's self-replenishing
// nit floor never blocks convergence; the threshold is the single tolerance knob (default 1: unlimited
// nits plus at most one minor). The weights are the fixed naive scheme (design chose a fixed scheme,
// only the threshold is user-facing). ADVISORY ONLY — this derives from the reviewer's own severities
// and never alters the verdict; it exists so an iterating author-agent has a deterministic stop signal.
const CONVERGENCE_WEIGHTS: SeverityCounts = { critical: 4, major: 2, minor: 1, nit: 0 };
export const DEFAULT_CONVERGENCE_THRESHOLD = 1;

export const convergenceScore = (counts: SeverityCounts): number =>
  SEVERITIES.reduce((sum, k) => sum + counts[k] * CONVERGENCE_WEIGHTS[k], 0);

// "**Convergence** 🏁 1 ≤ 1 — converged" / "**Convergence** 🔄 2 > 1 — iterating". The converged glyph
// is a checkered flag, NOT the verdict badge's ✅, so a reader (or the author-agent this steers) can't
// skim the line as an approval. Score and threshold print exactly (no lossy rounding) so the shown
// inequality can never contradict the computed comparison — `toFixed` could display "1 > 1.0" for 1 > 0.95.
// The verdict derives from convergenceSignal — the same `score <= threshold` decision the surfaced
// blob's literal `converged` uses — so the prose badge and the machine boolean can never disagree.
export const convergenceSummary = (
  counts: SeverityCounts,
  threshold: number = DEFAULT_CONVERGENCE_THRESHOLD,
): string => {
  const { score, converged } = convergenceSignal(counts, threshold);
  return converged
    ? `**Convergence** 🏁 ${String(score)} ≤ ${String(threshold)} — converged`
    : `**Convergence** 🔄 ${String(score)} > ${String(threshold)} — iterating`;
};

// The surfaced findings document — what the sticky/review-body findings-json marker actually embeds:
// the agent's validated findings doc, stamped with the surface version plus the stop signal for an
// author-agent that decodes the JSON (`converged` as a literal boolean, so the agent cannot get the
// weights wrong). The agent never writes the signal (it cannot know the score — the weights are
// commenter-side), so the draft schema does not carry it; `stripSurfaceFields` drops it when a
// surfaced doc feeds back into the agent channel (the re-review seed). A null signal still stamps
// the version, so the surface shape is always the marker's contract.
export const SURFACE_SCHEMA_VERSION = "0.6.0";

export interface ConvergenceSignal {
  readonly score: number;
  readonly threshold: number;
  readonly converged: boolean;
}

// The stop signal embedded in a surfaced doc: the round number + that round's score/threshold/
// converged. Computed once when the round completes; every later post carries it VERBATIM, never
// re-derived — re-deriving at a changed convergence_threshold would flip a prior round's `converged`.
export interface SurfaceSignal {
  readonly round: number;
  readonly convergence: ConvergenceSignal;
}

export type SurfaceFindings = Findings & Partial<SurfaceSignal>;

// The pure counts→signal computation, shared by post (a completing round) and render's fallback.
export const convergenceSignal = (
  counts: SeverityCounts,
  threshold: number = DEFAULT_CONVERGENCE_THRESHOLD,
): ConvergenceSignal => {
  const score = convergenceScore(counts);
  return { score, threshold, converged: score <= threshold };
};

// The full {round, convergence} construction, shared by post (a completing round) and render's
// fallback (the round-1 / last-round cases) — one helper so every site builds the same shape.
export const signalForRound = (
  round: number,
  counts: SeverityCounts,
  threshold: number = DEFAULT_CONVERGENCE_THRESHOLD,
): SurfaceSignal => ({ round, convergence: convergenceSignal(counts, threshold) });

export const surfaceFindings = (
  findings: Findings,
  signal: SurfaceSignal | null,
): SurfaceFindings => ({
  ...findings,
  schema_version: SURFACE_SCHEMA_VERSION,
  ...(signal === null ? {} : signal),
});

// The compact signal marker: the stop signal on its own, self-describing (it declares the surface
// version, so parseSurfaceSignal's version gate applies to it too). Embedded when the whole-doc
// payload falls to the link form, and appended by post to a signal-less blob (a notice) so a
// completed round's `converged` survives that write for the next post to read back.
export const signalMarker = (signal: SurfaceSignal): string =>
  `<!-- code-review:signal;base64 ${Buffer.from(
    JSON.stringify({ schema_version: SURFACE_SCHEMA_VERSION, ...signal }),
    "utf-8",
  ).toString("base64")} -->`;

// The whole-document marker, surfaced — one helper owns the construction so the sticky, the review
// body, and the standalone render can never disagree on the embedded shape. When the whole-doc
// payload falls to the link form (or is dropped), the compact signal marker still embeds — an
// oversized review's stop signal stays readable and can be carried forward by later posts.
export const surfacedFindingsPointer = (
  findings: Findings,
  signal: SurfaceSignal | null,
  jsonUrl: string | undefined,
): string => {
  const marker = findingsPointer(surfaceFindings(findings, signal), jsonUrl);
  // Probe the full embedded-marker prefix, never a bare substring — a link-form jsonUrl could
  // itself contain "findings-json;base64" (issue #141 review r4).
  if (signal === null || marker.includes("<!-- code-review:findings-json;base64 ")) return marker;
  return marker === "" ? signalMarker(signal) : `${marker}\n${signalMarker(signal)}`;
};

const SIGNAL_RE = /<!-- code-review:signal;base64 ([A-Za-z0-9+/=]+) -->/;

// The stop signal embedded on its own when the whole-doc marker fell to the link form — the
// counter-part of parseSurfaceSignal for a body carrying the compact marker.
export const parseSignalMarker = (body: string): SurfaceSignal | null => {
  const b64 = SIGNAL_RE.exec(body)?.[1];
  if (b64 === undefined) return null;
  return parseSurfaceSignal(decodeBase64Json(b64));
};

// Best-effort like parseRounds: the carried stop signal read back from a prior sticky's surfaced
// blob, null on any malformed shape, a pre-surface blob, or a doc that does not declare a surfaced
// version — so a draft or foreign document carrying round/convergence keys can never be treated as
// the commenter's stop signal (the same version gate stripSurfaceFields applies to the seed
// channel). A non-round post then carries nothing rather than embedding a corrupted signal.
export const parseSurfaceSignal = (doc: unknown): SurfaceSignal | null => {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  const declared = o["schema_version"];
  if (typeof declared !== "string" || !SURFACE_SCHEMA_VERSIONS.includes(declared)) return null;
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

// Every surfaced-document version this CLI can strip back to the agent document — grows with each
// surface version emitted, so a sticky written by an older release still seeds. A dedicated list,
// deliberately distinct from the draft-version registry axis: only these versions declare the
// surface shape, so a future draft bump can never be mistaken for one. Derived from the emitted
// version so the strip path can never silently stop recognizing what surfaceFindings stamps; a
// future surface bump appends the superseded version(s) here alongside the new one.
export const SURFACE_SCHEMA_VERSIONS: readonly string[] = [SURFACE_SCHEMA_VERSION];

// The inverse for the agent channel: the re-review seed decodes the sticky's surfaced blob, and the
// agent must only ever see its own document. Version-gated, not key-gated: a doc declaring a known
// SURFACE version has its pipeline-stamped convergence/round dropped and its version restored to
// the current draft default, so the seeded draft still validates; anything else (a draft version, an
// unknown future version, a malformed version) passes through untouched and fails or passes schema
// validation downstream on its own merits — never silently rewritten. A non-object stays as-is.
export const stripSurfaceFields = (doc: unknown): unknown => {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return doc;
  const o = doc as Record<string, unknown>;
  const declared = o["schema_version"];
  if (typeof declared !== "string" || !SURFACE_SCHEMA_VERSIONS.includes(declared)) return doc;
  const rest = Object.fromEntries(
    Object.entries(o).filter(([key]) => key !== "convergence" && key !== "round"),
  );
  return { ...rest, schema_version: DEFAULT_SCHEMA_VERSION };
};

// The machine-readable markers to carry forward when a comment's PROSE is replaced but its data must
// survive — the "review in progress" placeholder swaps the visible summary yet must not clobber the
// re-review seed the review job reads back from the sticky (the embedded findings + reviewed-sha), nor
// the round-history trajectory. The findings marker is extracted verbatim so both its base64 and
// jsonUrl-link forms survive; base64 (A–Z a–z 0–9 + / =) and URLs never contain '>', so `[^>]*` stops
// at its closing `-->`. The STOP directive that always precedes it is re-emitted from
// AGENTS_STOP_DIRECTIVE (its SSOT above) rather than re-matched, so a future edit to that constant
// can't silently desync a parallel regex. Returns "" when the body carries none of them.
export const carryForwardMarkers = (body: string): string => {
  const findings = /<!-- code-review:findings-json[^>]*-->/.exec(body)?.[0];
  const reviewedSha = /<!-- reviewed-sha: [0-9a-fA-F]{40} -->/.exec(body)?.[0];
  const rounds = ROUNDS_RE.exec(body)?.[0];
  const signal = SIGNAL_RE.exec(body)?.[0];
  const findingsBlock = findings ? `${AGENTS_STOP_DIRECTIVE}\n${findings}` : undefined;
  return [findingsBlock, reviewedSha, rounds, signal]
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

// The review-object body: the findings-json marker (when present) then a one-line pointer to the
// sticky. SSOT shared by the commenter (post.ts) and the `preview` command.
export const reviewBodyPointer = (
  headSha: string,
  stickyUrl: string | undefined,
  marker: string,
): string => {
  const sha7 = headSha.slice(0, 7);
  const linkLine = stickyUrl
    ? `🤖 Automated code review for \`${sha7}\` — see the [summary comment](${stickyUrl}) for the verdict, walkthrough, and cost.`
    : `🤖 Automated code review for \`${sha7}\` — see the summary comment for the verdict, walkthrough, and cost.`;
  return marker ? `${marker}\n\n${linkLine}` : linkLine;
};
