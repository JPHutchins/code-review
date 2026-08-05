// Single source of truth for the bits every render surface (sticky, inline comment, review body)
// must agree on: severity→emoji, the machine-readable findings-json marker, and patch→suggestion
// projection. Pure.

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

// ~30KB of JSON in base64 — well under GitHub's 65536-char comment limit.
const EMBED_LIMIT = 40000;

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
  const match = /<!-- code-review:findings-json;base64 ([A-Za-z0-9+/=]+) -->/.exec(body);
  const b64 = match?.[1];
  if (b64 === undefined) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
};

// Per-full-review-round severity counts, carried in a base64 marker so each completed full review
// appends its own and the sticky renders the convergence trajectory. A CI-fix mechanic pass carries it
// forward unchanged (it is not a review round). Best-effort like the findings marker: any
// non-conforming shape decodes to no history rather than throwing on this render path.
const ROUNDS_RE = /<!-- code-review:rounds;base64 ([A-Za-z0-9+/=]+) -->/;

const isSeverityCounts = (u: unknown): u is SeverityCounts =>
  typeof u === "object" &&
  u !== null &&
  (["critical", "major", "minor", "nit"] as const).every(
    (k) => typeof (u as Record<string, unknown>)[k] === "number",
  );

export const parseRounds = (body: string): readonly SeverityCounts[] => {
  const b64 = ROUNDS_RE.exec(body)?.[1];
  if (b64 === undefined) return [];
  try {
    const decoded: unknown = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    // Filter, not all-or-nothing: one future-shaped or corrupted round drops only itself rather than
    // erasing the whole trajectory (post re-serializes the parsed array on every write).
    return Array.isArray(decoded) ? decoded.filter(isSeverityCounts) : [];
  } catch {
    return [];
  }
};

export const roundsMarker = (rounds: readonly SeverityCounts[]): string =>
  rounds.length === 0
    ? ""
    : `<!-- code-review:rounds;base64 ${Buffer.from(JSON.stringify(rounds), "utf-8").toString("base64")} -->`;

// One round's chip: "🔴4 🟠3" for findings, "clean" for none.
const roundChip = (c: SeverityCounts): string => {
  const parts = (["critical", "major", "minor", "nit"] as const)
    .filter((k) => c[k] > 0)
    .map((k) => `${severityEmoji(k)}${String(c[k])}`);
  return parts.length === 0 ? "clean" : parts.join(" ");
};

// The convergence line: "**Round 3** · 🔴4 🟠3 → 🟠2 → clean"; "" when there is no round history. The
// round number is always the true count; the trajectory shows only the most recent chips (with a
// leading "…" when older ones are elided) so a long-running PR's line stays readable and bounded.
const TRAJECTORY_CHIPS = 8;
export const roundsSummary = (rounds: readonly SeverityCounts[]): string => {
  if (rounds.length === 0) return "";
  const chips = rounds.slice(-TRAJECTORY_CHIPS).map(roundChip);
  const trajectory =
    rounds.length > TRAJECTORY_CHIPS ? `… → ${chips.join(" → ")}` : chips.join(" → ");
  return `**Round ${String(rounds.length)}** · ${trajectory}`;
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
  const findingsBlock = findings ? `${AGENTS_STOP_DIRECTIVE}\n${findings}` : undefined;
  return [findingsBlock, reviewedSha, rounds]
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
