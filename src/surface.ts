// Shared render-surface primitives — the single source of truth for the bits every render surface
// (sticky, inline comment, review body) must agree on: the severity→emoji mapping, the
// machine-readable findings-json pointer (issue #19), and the patch→suggestion projection. Pure.

import type { Finding, Findings } from "./schema.js";
import { patchToSuggestion } from "./patch.js";

/** Severity → emoji, used by every render surface (sticky, inline, strays). */
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

/** Base64 chars (~30KB JSON); keeps a comment well under GitHub's 65536-char comment limit. */
const EMBED_LIMIT = 40000;

/** The directive that makes the marker below self-describing to a reviewing agent — travels with
 *  the marker on every surface so a reader who only sees one comment still knows to decode it. */
const AGENTS_STOP_DIRECTIVE =
  "<!-- AGENTS: STOP — do not parse the prose below; decode this findings JSON and read schema_version first. -->";

/** Shared core of the findings-json marker: base64-encodes `document` when it fits under `limit`,
 *  falls back to a `jsonUrl` link marker, or omits the marker entirely when neither is available —
 *  prefixed with the AGENTS_STOP directive whenever a marker is produced. */
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

/** The machine-readable findings-json marker (issue #19), identical on the sticky and the review
 *  body: embeds the whole `findings` document as base64 when it fits under `limit`, falls back to a
 *  `jsonUrl` link marker, or omits the marker entirely when neither is available. */
export const findingsPointer = (
  findings: Findings,
  jsonUrl: string | undefined,
  limit = EMBED_LIMIT,
): string => encodeMarker(findings, jsonUrl, limit);

/** The per-finding counterpart to {@link findingsPointer} (issue #31): each inline comment embeds
 *  only its own `finding` (with `schemaVersion`), not the entire findings document — the sticky and
 *  review body remain the whole-document SSOT. Same base64/limit/jsonUrl-fallback/AGENTS_STOP
 *  behavior as `findingsPointer`. */
export const findingPointer = (
  finding: Finding,
  schemaVersion: string,
  jsonUrl?: string,
  limit = EMBED_LIMIT,
): string => encodeMarker({ schema_version: schemaVersion, findings: [finding] }, jsonUrl, limit);

/** The inverse of {@link findingsPointer}'s base64 form: extract and decode the whole-document
 *  findings JSON a prior run embedded in a sticky/review body, or null when the body carries no
 *  base64 marker (e.g. the jsonUrl-link fallback used for oversized findings, which can't be decoded
 *  inline) or the payload isn't valid JSON. Returns the raw decoded value — callers validate it
 *  against the current schema before trusting it (a prior run may predate the current shape). Pure. */
export const parseFindingsMarker = (body: string): unknown => {
  const match = /<!-- code-review:findings-json;base64 ([A-Za-z0-9+/=]+) -->/.exec(body);
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1] ?? "", "base64").toString("utf-8"));
  } catch {
    return null;
  }
};

/** Escape triple-backtick sequences so fenced content can't break out of its block. */
const escapeFence = (text: string): string => text.replace(/```/g, "`` ` ``");

/** How a finding's `patch` renders on a surface (JP's core design): a GitHub ```suggestion when the
 *  patch lowers to replacement text (anchored at the finding's already-aligned range), a raw
 *  ```patch fallback when it can't lower (non-lossy — the diff still reaches the reader), or nothing
 *  when the finding carries no patch. Fenced content is backtick-escaped against breakout. */
export type PatchProjection =
  | { readonly kind: "suggestion"; readonly text: string }
  | { readonly kind: "patch"; readonly raw: string }
  | { readonly kind: "none" };

/** Project a finding's `patch` into a template-ready {@link PatchProjection}. Pure. */
export const projectPatch = (patch: string | undefined): PatchProjection => {
  if (patch === undefined) return { kind: "none" };
  const lowered = patchToSuggestion(patch);
  return typeof lowered === "string"
    ? { kind: "suggestion", text: escapeFence(lowered) }
    : { kind: "patch", raw: escapeFence(patch) };
};

/** Confidence, always at 2 decimal places (issue #26 — `1` renders `1.00`, `0.6` renders `0.60`). */
export const formatConfidence = (n: number): string => n.toFixed(2);

/** The review-object body: the shared findings-json marker (when present) followed by a one-line
 *  pointer to the sticky summary, linking to it when its URL is known. The single source of truth
 *  for this body, shared by the commenter (post.ts) and the `preview` command. Pure. */
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
