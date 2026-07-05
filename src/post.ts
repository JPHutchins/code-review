// Deterministic GH posting: resolve PR, fetch diff, run inline, post inline review,
// render summary, upsert sticky comment. Pure core with a thin gh-api effect.
//
// Ordering (CO-R3): all reads, decodes, diff validation, and rendering complete before
// the first API write; then the sticky is posted, and the inline review second. A posting
// failure propagates and exits the process non-zero (never partially posts).

import { readFileSync } from "node:fs";
import type { InlineComment } from "./types.js";
import { buildInlineComments, renderStraysSection } from "./inline.js";
import { isEmptyDiff } from "./diff.js";
import { render } from "./render.js";
import {
  ResultEnvelopeCodec,
  PriceMapCodec,
  TestSummaryCodec,
  DEFAULT_SCHEMA_VERSION,
} from "./schema.js";
import type { Findings, ResultEnvelope, TestSummary } from "./schema.js";
import { resolve, supportedVersions } from "./registry.js";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
export type { GhApi } from "./gh.js";
import { fetchDiff, fetchPrCandidates, resolvePr } from "./pr.js";

export interface PostInput {
  readonly repo: string;
  readonly headSha: string;
  readonly botLogin: string;
  readonly findingsPath: string;
  readonly envelopePath: string;
  readonly pricesPath: string;
  readonly templatePath: string;
  readonly inlineTemplatePath?: string;
  readonly route: string;
  readonly headBranch?: string;
  readonly testReportPath?: string;
  readonly effort?: string;
}

const DEFAULT_MARKER = "<!-- code-review -->";
const MAX_SUGGESTION_LINES = 10;
const REVIEWED_SHA_RE = /<!-- reviewed-sha: ([0-9a-f]{7,40}) -->/;

/** Count lines in a suggestion string (empty suggestion "" = 1 line — delete range). */
const countSuggestionLines = (text: string): number => text.split("\n").length;

/** Extract and check suggestion blocks in a comment body, stripping those that are too long. */
const checkLongSuggestions = (
  comments: readonly InlineComment[],
): { readonly comments: readonly InlineComment[]; readonly longFiles: readonly string[] } => {
  const longFiles: string[] = [];
  const adjusted = comments.map((c) => {
    const match = /```suggestion\n([\s\S]*?)\n```/.exec(c.body);
    if (match?.[1] && countSuggestionLines(match[1]) > MAX_SUGGESTION_LINES) {
      longFiles.push(`${c.path}:${String(c.line)}`);
      return {
        ...c,
        body: c.body.replace(
          /```suggestion\n[\s\S]*?\n```/,
          "*(suggestion omitted — exceeds GitHub's ~10-line suggestion limit; see summary)*",
        ),
      };
    }
    return c;
  });
  return { comments: adjusted, longFiles };
};

/** Extract the `<!-- reviewed-sha: <sha> -->` marker from a sticky comment body, if present. */
const extractReviewedSha = (commentBody: string): string | null =>
  REVIEWED_SHA_RE.exec(commentBody)?.[1] ?? null;

/** A synthetic findings object used for sticky-only notices (SPEC §5.5). */
const noticeFindings = (message: string): Findings => ({
  schema_version: DEFAULT_SCHEMA_VERSION,
  summary: `### ⚠️ ${message}`,
  verdict: "comment",
  findings: [],
});

// Loaders below never throw on untrusted artifacts (SPEC §5.5) — malformed input degrades to a
// tagged result the caller renders as a notice, rather than crashing the post.
type FindingsLoadResult =
  | { readonly kind: "ok"; readonly findings: Findings }
  | { readonly kind: "corrupt" }
  | { readonly kind: "invalid-shape" }
  | { readonly kind: "unsupported-schema-version"; readonly version: string };

const loadFindings = (path: string): FindingsLoadResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return { kind: "corrupt" };
  }
  const resolution = resolve("findings", raw);
  switch (resolution.kind) {
    case "ok":
      return { kind: "ok", findings: resolution.value };
    case "unsupported-version":
      return { kind: "unsupported-schema-version", version: resolution.version };
    case "invalid-shape":
    case "missing-version":
      return { kind: "invalid-shape" };
  }
};

const noticeMessageFor = (result: Exclude<FindingsLoadResult, { kind: "ok" }>): string => {
  switch (result.kind) {
    case "corrupt":
      return "Review output was missing or malformed — the review did not complete. See the workflow run for logs.";
    case "invalid-shape":
      return "Review output was malformed — it did not conform to the findings schema. See the workflow run for logs.";
    case "unsupported-schema-version": {
      const supported = supportedVersions("findings")
        .map((minor) => `${minor}.x`)
        .join(", ");
      return `Review output declares schema_version "${result.version}", which this commenter does not support (supported: ${supported}). See the workflow run for logs.`;
    }
  }
};

/** Load the result envelope; null on any read/decode failure (SPEC §5.5 — degrade, never crash). */
const loadEnvelope = (path: string): ResultEnvelope | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
  const decoded = ResultEnvelopeCodec.decode(raw);
  return decoded._tag === "Right" ? decoded.right : null;
};

/** Load an optional test report; undefined (and a warning) on any read/decode failure — REQ-CO-9
 *  enrichment is optional and MUST degrade gracefully, never abort the post. */
const loadTestReport = (path: string): TestSummary | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (err) {
    process.stderr.write(
      `Warning: could not read test report at ${path}: ${err instanceof Error ? err.message : String(err)} — omitting test panel\n`,
    );
    return undefined;
  }
  const decoded = TestSummaryCodec.decode(raw);
  if (decoded._tag === "Left") {
    process.stderr.write(
      `Warning: test report at ${path} does not match the expected shape — omitting test panel\n`,
    );
    return undefined;
  }
  return decoded.right;
};

const postInlineReview = async (
  repo: string,
  prNumber: number,
  headSha: string,
  comments: readonly InlineComment[],
  ghApi: GhApi,
): Promise<void> => {
  const body = JSON.stringify({
    body: "",
    commit_id: headSha,
    event: "COMMENT",
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      ...(c.start_line !== undefined && c.start_side !== undefined
        ? { start_line: c.start_line, start_side: c.start_side }
        : {}),
      body: c.body,
    })),
  });
  await ghApi([`repos/${repo}/pulls/${String(prNumber)}/reviews`, "--input", "-"], body);
};

const findBotComment = async (
  repo: string,
  prNumber: number,
  botLogin: string,
  marker: string,
  ghApi: GhApi,
): Promise<{ readonly id: number; readonly body: string } | null> => {
  const stdout = await ghApi(
    [
      `repos/${repo}/issues/${String(prNumber)}/comments`,
      "--paginate",
      "--jq",
      ".[] | select(.user.login == env.CODE_REVIEW_BOT_LOGIN and (.body | startswith(env.CODE_REVIEW_MARKER))) | {id: .id, body: .body}",
    ],
    undefined,
    { CODE_REVIEW_BOT_LOGIN: botLogin, CODE_REVIEW_MARKER: marker },
  );
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1] ?? null;
  if (last === null) return null;
  const parsed = JSON.parse(last) as { id: number; body: string };
  return { id: parsed.id, body: parsed.body };
};

const patchComment = async (
  repo: string,
  commentId: number,
  body: string,
  ghApi: GhApi,
): Promise<void> => {
  await ghApi(
    [`repos/${repo}/issues/comments/${String(commentId)}`, "--input", "-"],
    JSON.stringify({ body }),
  );
};

const postComment = async (
  repo: string,
  prNumber: number,
  body: string,
  ghApi: GhApi,
): Promise<void> => {
  await ghApi(
    [`repos/${repo}/issues/${String(prNumber)}/comments`, "--input", "-"],
    JSON.stringify({ body }),
  );
};

/** Upsert the sticky summary — trust by author identity (bot login), not marker alone (§5.3). */
const upsertSticky = async (
  repo: string,
  prNumber: number,
  existing: { readonly id: number; readonly body: string } | null,
  body: string,
  ghApi: GhApi,
): Promise<void> => {
  if (existing !== null) {
    await patchComment(repo, existing.id, body, ghApi);
    process.stderr.write(
      `Updated sticky comment #${String(existing.id)} on PR #${String(prNumber)}\n`,
    );
  } else {
    await postComment(repo, prNumber, body, ghApi);
    process.stderr.write(`Posted new sticky comment on PR #${String(prNumber)}\n`);
  }
};

interface BotReview {
  readonly id: number;
  readonly login: string;
  readonly state: string;
}

const isBotReview = (r: unknown): r is BotReview =>
  typeof r === "object" &&
  r !== null &&
  typeof (r as { id?: unknown }).id === "number" &&
  typeof (r as { state?: unknown }).state === "string" &&
  typeof (r as { user?: { login?: unknown } }).user?.login === "string";

const fetchBotReviewIds = async (
  repo: string,
  prNumber: number,
  botLogin: string,
  ghApi: GhApi,
): Promise<readonly number[]> => {
  const stdout = await ghApi([`repos/${repo}/pulls/${String(prNumber)}/reviews`, "--paginate"]);
  let reviews: unknown;
  try {
    reviews = JSON.parse(stdout || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(reviews)) return [];
  return reviews
    .filter((r): r is { id: number; user: { login: string }; state: string } => isBotReview(r))
    .filter((r) => r.user.login === botLogin && r.state !== "DISMISSED")
    .map((r) => r.id);
};

/** Dismiss prior bot-authored reviews (REC-CO-2). Failures are logged, never fail the job. */
const dismissPriorBotReviews = async (
  repo: string,
  prNumber: number,
  botLogin: string,
  ghApi: GhApi,
): Promise<void> => {
  const ids = await fetchBotReviewIds(repo, prNumber, botLogin, ghApi);
  for (const id of ids) {
    try {
      await ghApi(
        [
          `repos/${repo}/pulls/${String(prNumber)}/reviews/${String(id)}/dismissals`,
          "-X",
          "PUT",
          "--input",
          "-",
        ],
        JSON.stringify({ message: "Superseded by a new review for an updated commit." }),
      );
    } catch (err) {
      process.stderr.write(
        `Warning: failed to dismiss prior review #${String(id)} on PR #${String(prNumber)}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
};

export const post = async (input: PostInput, ghApi: GhApi = runGhApi): Promise<void> => {
  // Phase 1 (CO-R3): reads, decodes, diff validation, rendering — no writes yet.
  const candidates = await fetchPrCandidates(input.repo, input.headSha, ghApi);
  const resolution = resolvePr(candidates, input.headBranch);
  if (resolution.kind === "none") {
    process.stderr.write(`No open PR for ${input.headSha} — nothing to post\n`);
    process.exit(0);
  }
  if (resolution.kind === "not-open") {
    process.stderr.write(
      `PR #${String(resolution.prNumber)} for ${input.headSha} is not open (state: ${resolution.state}) — nothing to post\n`,
    );
    process.exit(0);
  }
  const prNumber = resolution.prNumber;

  const diff = await fetchDiff(input.repo, prNumber, ghApi);
  const existingSticky = await findBotComment(
    input.repo,
    prNumber,
    input.botLogin,
    DEFAULT_MARKER,
    ghApi,
  );
  const previousReviewedSha = existingSticky ? extractReviewedSha(existingSticky.body) : null;
  const isRerunOfSameSha = previousReviewedSha !== null && previousReviewedSha === input.headSha;

  const prices = JSON.parse(readFileSync(input.pricesPath, "utf-8")) as unknown;
  const decodedPrices = PriceMapCodec.decode(prices);
  if (decodedPrices._tag === "Left") {
    throw new Error(`Price map at ${input.pricesPath} does not match the expected shape`);
  }
  const template = readFileSync(input.templatePath, "utf-8");
  const inlineTemplate = input.inlineTemplatePath
    ? readFileSync(input.inlineTemplatePath, "utf-8")
    : undefined;

  const renderNotice = (message: string): string =>
    render({
      findings: noticeFindings(message),
      envelope: null,
      prices: decodedPrices.right,
      template,
      route: input.route,
      reviewedSha: input.headSha,
      effort: input.effort,
    });

  if (isEmptyDiff(diff)) {
    await upsertSticky(
      input.repo,
      prNumber,
      existingSticky,
      renderNotice("The diff for this PR is empty — nothing to review."),
      ghApi,
    );
    process.exit(0);
  }

  const findingsResult = loadFindings(input.findingsPath);
  if (findingsResult.kind !== "ok") {
    await upsertSticky(
      input.repo,
      prNumber,
      existingSticky,
      renderNotice(noticeMessageFor(findingsResult)),
      ghApi,
    );
    process.exit(0);
  }
  const findings = findingsResult.findings;

  const envelope = loadEnvelope(input.envelopePath);
  const testReport = input.testReportPath ? loadTestReport(input.testReportPath) : undefined;

  if (envelope === null) {
    const body = render({
      findings,
      envelope: null,
      prices: decodedPrices.right,
      template,
      route: input.route,
      reviewedSha: input.headSha,
      effort: input.effort,
      testReport,
    });
    await upsertSticky(input.repo, prNumber, existingSticky, body, ghApi);
    process.stderr.write(
      "Result envelope missing or malformed — posted sticky summary without usage/cost data; no inline review\n",
    );
    process.exit(0);
  }

  const { comments: rawComments, strays } = buildInlineComments(
    findings.findings,
    diff,
    inlineTemplate,
  );
  const { comments, longFiles } = checkLongSuggestions(rawComments);
  for (const wf of longFiles) {
    process.stderr.write(
      `Warning: suggestion in ${wf} exceeds ${String(MAX_SUGGESTION_LINES)} lines — omitted from inline to avoid 422\n`,
    );
  }

  let body = render({
    findings,
    envelope,
    prices: decodedPrices.right,
    template,
    route: input.route,
    reviewedSha: input.headSha,
    effort: input.effort,
    testReport,
  });

  const straysMd = renderStraysSection(strays);
  if (straysMd.length > 0) body += straysMd;

  if (longFiles.length > 0) {
    body += `\n\n---\n\n> **Note:** ${String(longFiles.length)} suggestion(s) exceeded GitHub's ~10-line inline suggestion limit and were omitted from inline comments. See the findings above for details.\n`;
  }

  // Phase 2 (CO-R3): writes — sticky first, inline second; failure exits non-zero.
  if (!isRerunOfSameSha && previousReviewedSha !== null) {
    await dismissPriorBotReviews(input.repo, prNumber, input.botLogin, ghApi);
  }

  await upsertSticky(input.repo, prNumber, existingSticky, body, ghApi);

  if (isRerunOfSameSha) {
    process.stderr.write(
      `Head SHA ${input.headSha} matches the previous review — updated sticky only, no new inline review\n`,
    );
    return;
  }

  if (comments.length > 0) {
    await postInlineReview(input.repo, prNumber, input.headSha, comments, ghApi);
    process.stderr.write(
      `Posted ${String(comments.length)} inline comments on PR #${String(prNumber)}\n`,
    );
  }
};
