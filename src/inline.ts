// Inline review payload builder. Validates findings against the diff,
// builds the GitHub reviews API comments[] array, and demotes strays.

import { Eta } from "eta";
import { partitionFindings, indexDiff, defaultSide } from "./diff.js";
import type { Finding } from "./schema.js";
import type { InlineComment, InlineResult } from "./types.js";

/** Escape triple-backtick sequences inside suggestion text to prevent code-block breakout. */
const escapeBackticks = (text: string): string => text.replace(/```/g, "`` ` ``");

/** Build a single inline comment body from a finding using the default format. */
export const buildCommentBody = (f: Finding): string => {
  const parts = [f.body];
  if (f.suggestion !== null && f.suggestion !== undefined) {
    const safe = escapeBackticks(f.suggestion);
    parts.push(`\`\`\`suggestion\n${safe}\n\`\`\``);
  }
  return parts.join("\n\n");
};

/** Render a finding's inline comment body using an Eta template. */
const renderCommentBody = (f: Finding, eta: Eta, template: string): string => {
  // Eta.renderString returns string | Promise<string>; with autoTrim:false it's always sync.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return eta.renderString(template, {
    ...f,
    suggestion:
      f.suggestion !== null && f.suggestion !== undefined ? escapeBackticks(f.suggestion) : null,
  }) as string;
};

/** Build the GitHub reviews API comments[] array from in-diff findings. Strays are demoted.
 *  If an inline template is provided, it's used to format each comment body. */
export const buildInlineComments = (
  findings: readonly Finding[],
  diff: string,
  inlineTemplate?: string,
): InlineResult => {
  const index = indexDiff(diff);
  const { inDiff, strays } = partitionFindings(findings, index);
  const eta = inlineTemplate ? new Eta({ autoTrim: false }) : null;

  const comments: InlineComment[] = inDiff.map((f) => {
    const comment: InlineComment = {
      path: f.path,
      line: f.end_line,
      side: defaultSide(f.side),
      body: eta && inlineTemplate ? renderCommentBody(f, eta, inlineTemplate) : buildCommentBody(f),
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
