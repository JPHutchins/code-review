// Inline review payload builder. Validates findings against the diff,
// builds the GitHub reviews API comments[] array, and demotes strays.

import { Eta } from "eta";
import { partitionFindings, indexDiff, defaultSide } from "./diff.js";
import type { Finding } from "./schema.js";
import type { InlineComment, InlineResult } from "./types.js";

/** Escape triple-backtick sequences inside suggestion text to prevent code-block breakout. */
const escapeBackticks = (text: string): string => text.replace(/```/g, "`` ` ``");

/** Severity → emoji, mirroring the sticky's mapping (render.ts) — duplicated rather than imported
 *  since render.ts's mapping is a private closure, and render.ts is out of this slice's scope. */
const severityEmoji = (s: string): string => {
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

/** `<emoji> **<severity>** — <title>` header prepended to every inline comment (issue #12). */
const severityHeader = (f: Finding): string =>
  `${severityEmoji(f.severity)} **${f.severity}** — ${f.title}`;

/** The agent-facing findings-json marker (issue #15), or undefined when no URL is available. */
const jsonUrlMarker = (jsonUrl: string | undefined): string | undefined =>
  jsonUrl ? `<!-- code-review:findings-json ${jsonUrl} -->` : undefined;

/** Backtick-wrapped, `/`-joined model names for the disclosure line (issue #16), falling back to
 *  a plain phrase when no models are known. */
const formatModels = (models: readonly string[]): string =>
  models.length > 0 ? models.map((m) => `\`${m}\``).join("/") : "an AI model";

/** Build a single inline comment body from a finding using the default format. The disclosure
 *  fold (model/confidence/reasoning) is template-only (issue #16) — this built-in path carries
 *  only the severity header and the findings-json marker so it isn't strictly worse than a
 *  template. */
export const buildCommentBody = (f: Finding, jsonUrl?: string): string => {
  const marker = jsonUrlMarker(jsonUrl);
  const parts = [...(marker ? [marker] : []), severityHeader(f), f.body];
  if (f.suggestion !== null && f.suggestion !== undefined) {
    const safe = escapeBackticks(f.suggestion);
    parts.push(`\`\`\`suggestion\n${safe}\n\`\`\``);
  }
  return parts.join("\n\n");
};

/** Render a finding's inline comment body using an Eta template. */
const renderCommentBody = (
  f: Finding,
  eta: Eta,
  template: string,
  modelsText: string,
  jsonUrl: string | undefined,
): string => {
  // Eta.renderString returns string | Promise<string>; with autoTrim:false it's always sync.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return eta.renderString(template, {
    ...f,
    suggestion:
      f.suggestion !== null && f.suggestion !== undefined ? escapeBackticks(f.suggestion) : null,
    severityEmoji,
    modelsText,
    jsonUrl: jsonUrl ?? null,
  }) as string;
};

/** Extra context threaded into each inline comment beyond the finding itself. */
export interface InlineContext {
  readonly inlineTemplate?: string;
  /** Model name(s) that produced the review, for the template's disclosure line (issue #16). */
  readonly models?: readonly string[];
  /** Findings-json artifact URL, emitted as the first line of each comment when set (issue #15). */
  readonly jsonUrl?: string;
}

/** Build the GitHub reviews API comments[] array from in-diff findings. Strays are demoted.
 *  If an inline template is provided, it's used to format each comment body. */
export const buildInlineComments = (
  findings: readonly Finding[],
  diff: string,
  context: InlineContext = {},
): InlineResult => {
  const { inlineTemplate, models = [], jsonUrl } = context;
  const index = indexDiff(diff);
  const { inDiff, strays } = partitionFindings(findings, index);
  const eta = inlineTemplate ? new Eta({ autoTrim: false }) : null;
  const modelsText = formatModels(models);

  const comments: InlineComment[] = inDiff.map((f) => {
    const comment: InlineComment = {
      path: f.path,
      line: f.end_line,
      side: defaultSide(f.side),
      body:
        eta && inlineTemplate
          ? renderCommentBody(f, eta, inlineTemplate, modelsText, jsonUrl)
          : buildCommentBody(f, jsonUrl),
    };
    if (f.start_line < f.end_line) {
      return {
        ...comment,
        start_line: f.start_line,
        start_side: defaultSide(f.side),
      };
    }
    return comment;
  });

  return { comments, strays };
};

/** Render the demoted (stray) findings as a markdown section for the summary. */
export const renderStraysSection = (strays: readonly Finding[]): string => {
  if (strays.length === 0) return "";

  const items = strays.map(
    (f) => `- **${f.severity}** · \`${f.path}:${String(f.start_line)}\` — ${f.title}`,
  );

  return [
    "",
    "---",
    "",
    "#### ⚠️ Findings on lines not in the diff (demoted to summary)",
    "",
    ...items,
  ].join("\n");
};
