// Shared render-surface primitives — the single source of truth for the bits every render surface
// (sticky, inline comment, review body) must agree on: the severity→emoji mapping, the
// machine-readable findings-json pointer (issue #19), and the patch→suggestion projection. Pure.

import type { Findings } from "./schema.js";
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

/** The machine-readable findings-json marker (issue #19), identical on every surface: embeds
 *  `findings` as base64 when it fits under `limit`, falls back to a `jsonUrl` link marker, or
 *  omits the marker entirely when neither is available. */
export const findingsPointer = (
  findings: Findings,
  jsonUrl: string | undefined,
  limit = EMBED_LIMIT,
): string => {
  const b64 = Buffer.from(JSON.stringify(findings), "utf-8").toString("base64");
  const marker =
    b64.length <= limit
      ? `<!-- code-review:findings-json;base64 ${b64} -->`
      : jsonUrl
        ? `<!-- code-review:findings-json ${jsonUrl} -->`
        : "";
  return marker ? `${AGENTS_STOP_DIRECTIVE}\n${marker}` : "";
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
