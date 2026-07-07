// Inline review payload builder. Validates findings against the diff,
// builds the GitHub reviews API comments[] array, and demotes strays.

import { Eta } from "eta";
import { partitionFindings, indexDiff, defaultSide } from "./diff.js";
import { severityEmoji, findingsPointer, projectPatch } from "./surface.js";
import type { Finding, Findings } from "./schema.js";
import type { InlineComment, InlineResult } from "./types.js";

/** Backtick-wrapped, `/`-joined model names for the disclosure line (issue #16), falling back to
 *  a plain phrase when no models are known. */
const formatModels = (models: readonly string[]): string =>
  models.length > 0 ? models.map((m) => `\`${m}\``).join("/") : "an AI model";

/** Render a finding's inline comment body via the inline Eta template (bundled by default — see
 *  resolveInlineTemplatePath, index.ts). The template is the SSOT for all body text — severity
 *  header, description, recommendation, the projected patch block, and the [!TIP] disclosure fold;
 *  TS supplies only data. The patch is projected here (never a `suggestion` field — that field is
 *  gone as of schema 0.4). */
const renderCommentBody = (
  f: Finding,
  eta: Eta,
  template: string,
  modelsText: string,
  jsonUrl: string | undefined,
  pointer: string,
): string =>
  // Eta.renderString returns string | Promise<string>; with autoTrim:false it's always sync.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  eta.renderString(template, {
    ...f,
    patchProjection: projectPatch(f.patch),
    severityEmoji,
    modelsText,
    jsonUrl: jsonUrl ?? null,
    findingsPointer: pointer,
  }) as string;

/** Extra context threaded into each inline comment beyond the finding itself. */
export interface InlineContext {
  /** Eta template for each comment's body — bundled by default (index.ts's
   *  resolveInlineTemplatePath), overridable via --inline-template. */
  readonly inlineTemplate: string;
  /** Model name(s) that produced the review, for the template's disclosure line (issue #16). */
  readonly models?: readonly string[];
  /** Findings-json artifact URL — the marker's fallback when the embedded form is too large (#19). */
  readonly jsonUrl?: string;
  /** The full findings document, embedded (or pointed at) via the shared marker (#19); omitted
   *  when the caller has no whole document to embed (the marker is then omitted too). */
  readonly findings?: Findings;
}

/** Build the GitHub reviews API comments[] array from in-diff findings. Strays are demoted. */
export const buildInlineComments = (
  findings: readonly Finding[],
  diff: string,
  context: InlineContext,
): InlineResult => {
  const { inlineTemplate, models = [], jsonUrl, findings: fullFindings } = context;
  const index = indexDiff(diff);
  const { inDiff, strays } = partitionFindings(findings, index);
  const eta = new Eta({ autoTrim: false });
  const modelsText = formatModels(models);
  const pointer = fullFindings ? findingsPointer(fullFindings, jsonUrl) : "";

  const comments: InlineComment[] = inDiff.map((f) => {
    const comment: InlineComment = {
      path: f.path,
      line: f.end_line,
      side: defaultSide(f.side),
      body: renderCommentBody(f, eta, inlineTemplate, modelsText, jsonUrl, pointer),
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
