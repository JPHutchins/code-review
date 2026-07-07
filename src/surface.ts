// Shared render-surface primitives — the single source of truth for the bits every render surface
// (sticky, inline comment, review body) must agree on: the severity→emoji mapping and the
// machine-readable findings-json pointer (issue #19). Pure; no side effects.

import type { Findings } from "./schema.js";

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
