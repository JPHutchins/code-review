import { Eta } from "eta";
import { partitionFindings, indexDiff, defaultSide } from "./diff.js";
import { severityEmoji, findingPointer, projectPatch, formatConfidence } from "./surface.js";
import type { Finding, Findings } from "./schema.js";
import type { InlineComment, InlineResult } from "./types.js";

const formatModels = (models: readonly string[]): string =>
  models.length > 0 ? models.map((m) => `\`${m}\``).join("/") : "an AI model";

// The template is the SSOT for all body text; TS supplies only data. The patch is projected here
// (never a `suggestion` field — that field is gone as of schema 0.4).
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
    formatConfidence,
    modelsText,
    jsonUrl: jsonUrl ?? null,
    findingsPointer: pointer,
  }) as string;

export interface InlineContext {
  readonly inlineTemplate: string;
  readonly models?: readonly string[];
  readonly jsonUrl?: string;
  // Each in-diff comment embeds only its OWN finding, but needs the document's schema_version to do
  // so; omitted when the caller has no document (each comment's marker is then omitted too).
  readonly findings?: Findings;
}

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

  const comments: InlineComment[] = inDiff.map((f) => {
    const pointer = fullFindings ? findingPointer(f, fullFindings.schema_version, jsonUrl) : "";
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

  return { comments, strays, inDiff };
};

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
