// Ordering invariant: all reads, decodes, and rendering complete before the first API write; then
// the sticky, then the inline review. A posting failure propagates and exits non-zero (never partial).

import { readFileSync } from "node:fs";
import type { InlineComment, InlineDisposition, RenderInput } from "./types.js";
import { buildInlineComments } from "./inline.js";
import { isEmptyDiff } from "./diff.js";
import { render, computeSeverityCounts } from "./render.js";
import { formatMarkdown } from "./format.js";
import { findingsPointer, reviewBodyPointer } from "./surface.js";
import { ResultEnvelopeCodec, PriceMapCodec, TestSummaryCodec, noticeFindings } from "./schema.js";
import type { Finding, Findings, ResultEnvelope, TestSummary } from "./schema.js";
import { resolve, supportedVersions } from "./registry.js";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
export type { GhApi } from "./gh.js";
import { fetchDiff, fetchPrCandidates, resolvePr } from "./pr.js";
import { errMsg, tryParseJson, asRecord } from "./util.js";

export interface PostInput {
  readonly repo: string;
  readonly headSha: string;
  readonly botLogin: string;
  readonly findingsPath: string;
  readonly envelopePath: string;
  readonly pricesPath: string;
  // false ⇒ the bundled all-zero example; the render layer shows cost as N/A, never a false $0.00.
  readonly pricesProvided: boolean;
  readonly templatePath: string;
  readonly inlineTemplatePath: string;
  readonly route?: string;
  readonly headBranch?: string;
  readonly testReportPath?: string;
  readonly effort?: string;
  readonly runUrl?: string;
  // Findings-json marker's fallback across surfaces when the embedded form is too large.
  readonly jsonUrl?: string;
  // Computed by the caller via formatUtc so post() stays a clockless pass-through into render().
  readonly postedAt?: string;
}

const DEFAULT_MARKER = "<!-- code-review -->";
const MAX_SUGGESTION_LINES = 10;

const countSuggestionLines = (text: string): number => text.split("\n").length;

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

// Loaders never throw on untrusted artifacts — malformed input degrades to a tagged result the
// caller renders as a notice, never crashing the post.
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

// Optional enrichment: any failure warns and returns undefined, never aborts the post.
const loadTestReport = (path: string): TestSummary | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (err) {
    process.stderr.write(
      `Warning: could not read test report at ${path}: ${errMsg(err)} — omitting test panel\n`,
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

const parseHtmlUrl = (raw: string): string | undefined => {
  const parsed = tryParseJson(raw);
  const htmlUrl = parsed.ok ? asRecord(parsed.value)?.["html_url"] : undefined;
  return typeof htmlUrl === "string" ? htmlUrl : undefined;
};

const commentPayload = (c: InlineComment): Record<string, unknown> => ({
  path: c.path,
  line: c.line,
  side: c.side,
  ...(c.start_line !== undefined && c.start_side !== undefined
    ? { start_line: c.start_line, start_side: c.start_side }
    : {}),
  body: formatMarkdown(c.body),
});

// comments[i] is the rendered comment for inDiff[i] (1:1, same order). Returns the review url, the
// count that actually posted, and the findings GitHub rejected (for the caller to surface in the sticky).
const postInlineReview = async (
  repo: string,
  prNumber: number,
  headSha: string,
  comments: readonly InlineComment[],
  inDiff: readonly Finding[],
  stickyUrl: string | undefined,
  marker: string,
  ghApi: GhApi,
): Promise<{
  readonly url: string | undefined;
  readonly inlinePosted: number;
  readonly unposted: readonly Finding[];
}> => {
  const pointer = reviewBodyPointer(headSha, stickyUrl, marker);
  const reviewBody = (withComments: boolean): string =>
    JSON.stringify({
      body: pointer,
      commit_id: headSha,
      event: "COMMENT",
      comments: withComments ? comments.map(commentPayload) : [],
    });
  const reviewsEndpoint = [`repos/${repo}/pulls/${String(prNumber)}/reviews`, "--input", "-"];
  try {
    const stdout = await ghApi(reviewsEndpoint, reviewBody(true));
    return { url: parseHtmlUrl(stdout), inlinePosted: comments.length, unposted: [] };
  } catch (err) {
    // The reviews endpoint is atomic — one rejected position fails the whole batch — so on rejection
    // post the body only, then re-post each comment individually, collecting the ones GitHub rejects.
    // A body-only review that itself fails (no comments) is a genuine error and propagates.
    if (comments.length === 0) throw err;
    process.stderr.write(
      `Warning: the batched inline review on PR #${String(prNumber)} was rejected (${errMsg(err)}) — posting the review body-only, then each comment individually to keep the ones GitHub accepts (issue #57)\n`,
    );
    const url = parseHtmlUrl(await ghApi(reviewsEndpoint, reviewBody(false)));
    const commentsEndpoint = [`repos/${repo}/pulls/${String(prNumber)}/comments`, "--input", "-"];
    const unposted: Finding[] = [];
    let inlinePosted = 0;
    for (const [i, c] of comments.entries()) {
      try {
        await ghApi(commentsEndpoint, JSON.stringify({ commit_id: headSha, ...commentPayload(c) }));
        inlinePosted += 1;
      } catch (e) {
        const finding = inDiff[i];
        if (finding) unposted.push(finding);
        process.stderr.write(
          `Warning: inline comment on ${c.path}:${String(c.line)} rejected (${errMsg(e)}) — surfacing that finding in the sticky instead (issue #57)\n`,
        );
      }
    }
    return { url, inlinePosted, unposted };
  }
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

const parseCommentRef = (
  raw: string,
): { readonly id: number; readonly html_url: string } | null => {
  const parsed = tryParseJson(raw);
  const rec = parsed.ok ? asRecord(parsed.value) : null;
  const id = rec?.["id"];
  const html_url = rec?.["html_url"];
  return typeof id === "number" && typeof html_url === "string" ? { id, html_url } : null;
};

const patchComment = async (
  repo: string,
  commentId: number,
  body: string,
  ghApi: GhApi,
): Promise<{ readonly html_url: string } | null> => {
  const stdout = await ghApi(
    [`repos/${repo}/issues/comments/${String(commentId)}`, "--input", "-"],
    JSON.stringify({ body }),
  );
  // Only html_url is needed — the id is already known — unlike parseCommentRef for a new comment.
  const htmlUrl = parseHtmlUrl(stdout);
  return htmlUrl !== undefined ? { html_url: htmlUrl } : null;
};

const postComment = async (
  repo: string,
  prNumber: number,
  body: string,
  ghApi: GhApi,
): Promise<{ readonly id: number; readonly html_url: string } | null> => {
  const stdout = await ghApi(
    [`repos/${repo}/issues/${String(prNumber)}/comments`, "--input", "-"],
    JSON.stringify({ body }),
  );
  return parseCommentRef(stdout);
};

// Trust by author identity (bot login), not the marker alone. Returns null only when a NEW comment's
// response couldn't be parsed — there is then no id to re-patch with the review link.
const upsertSticky = async (
  repo: string,
  prNumber: number,
  existing: { readonly id: number; readonly body: string } | null,
  body: string,
  ghApi: GhApi,
): Promise<{ readonly id: number; readonly url: string | undefined } | null> => {
  if (existing !== null) {
    const patched = await patchComment(repo, existing.id, body, ghApi);
    process.stderr.write(
      `Updated sticky comment #${String(existing.id)} on PR #${String(prNumber)}\n`,
    );
    return { id: existing.id, url: patched?.html_url };
  }
  const posted = await postComment(repo, prNumber, body, ghApi);
  process.stderr.write(`Posted new sticky comment on PR #${String(prNumber)}\n`);
  return posted ? { id: posted.id, url: posted.html_url } : null;
};

// Only the id is needed — every prior bot review is superseded regardless of the commit it reviewed.
interface BotReviewRef {
  readonly id: number;
}

const isBotReview = (r: unknown): r is { id: number; user: { login: string }; state: string } =>
  typeof r === "object" &&
  r !== null &&
  typeof (r as { id?: unknown }).id === "number" &&
  typeof (r as { state?: unknown }).state === "string" &&
  typeof (r as { user?: { login?: unknown } }).user?.login === "string";

const fetchBotReviews = async (
  repo: string,
  prNumber: number,
  botLogin: string,
  ghApi: GhApi,
): Promise<readonly BotReviewRef[]> => {
  const stdout = await ghApi([`repos/${repo}/pulls/${String(prNumber)}/reviews`, "--paginate"]);
  let reviews: unknown;
  try {
    reviews = JSON.parse(stdout || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(reviews)) return [];
  return reviews
    .filter(isBotReview)
    .filter((r) => r.user.login === botLogin && r.state !== "DISMISSED")
    .map((r) => ({ id: r.id }));
};

// Best-effort: a dismissal failure is logged, never fails the job.
const dismissReviews = async (
  repo: string,
  prNumber: number,
  ids: readonly number[],
  ghApi: GhApi,
): Promise<void> => {
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
        `Warning: failed to dismiss prior review #${String(id)} on PR #${String(prNumber)}: ${errMsg(err)}\n`,
      );
    }
  }
};

// Capped at the first 100 threads (×100 comments each); hasNextPage flags a PR that exceeds it.
const REVIEW_THREAD_COMMENTS_QUERY =
  "query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){pageInfo{hasNextPage}nodes{comments(first:100){nodes{id isMinimized author{login}}}}}}}}";

// Reversible — minimized as OUTDATED, not deleted.
const MINIMIZE_COMMENT_MUTATION =
  "mutation($id:ID!){minimizeComment(input:{subjectId:$id,classifier:OUTDATED}){minimizedComment{isMinimized}}}";

// GraphQL reports the bare login (github-actions), so match with and without the REST [bot] suffix.
const priorBotCommentId = (c: unknown, logins: readonly string[]): string | null => {
  if (typeof c !== "object" || c === null) return null;
  const o = c as { id?: unknown; isMinimized?: unknown; author?: { login?: unknown } | null };
  const login = o.author?.login;
  return typeof o.id === "string" &&
    o.isMinimized !== true &&
    typeof login === "string" &&
    logins.includes(login)
    ? o.id
    : null;
};

const priorBotCommentIds = (
  raw: string,
  botLogin: string,
): { readonly ids: readonly string[]; readonly truncated: boolean } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ids: [], truncated: false };
  }
  const conn = (
    parsed as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } };
          };
        };
      };
    }
  ).data?.repository?.pullRequest?.reviewThreads;
  const truncated = conn?.pageInfo?.hasNextPage === true;
  const nodes = conn?.nodes;
  if (!Array.isArray(nodes)) return { ids: [], truncated };
  const logins = [botLogin.replace(/\[bot\]$/, ""), botLogin];
  const ids = nodes.flatMap((t) => {
    const cnodes = (t as { comments?: { nodes?: unknown } }).comments?.nodes;
    return Array.isArray(cnodes)
      ? cnodes.map((c) => priorBotCommentId(c, logins)).filter((id): id is string => id !== null)
      : [];
  });
  return { ids, truncated };
};

// Snapshot BEFORE posting the fresh review, so the set is exactly the prior (stale) comments.
// Best-effort: a listing failure logs and returns [].
const listPriorBotCommentIds = async (
  repo: string,
  prNumber: number,
  botLogin: string,
  ghApi: GhApi,
): Promise<readonly string[]> => {
  const slash = repo.indexOf("/");
  if (slash <= 0) return [];
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  let raw: string;
  try {
    raw = await ghApi([
      "graphql",
      "-f",
      `query=${REVIEW_THREAD_COMMENTS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `pr=${String(prNumber)}`,
    ]);
  } catch (err) {
    process.stderr.write(
      `Warning: could not list review threads to minimize stale comments on PR #${String(prNumber)}: ${errMsg(err)}\n`,
    );
    return [];
  }
  const { ids, truncated } = priorBotCommentIds(raw, botLogin);
  if (truncated) {
    process.stderr.write(
      `Note: PR #${String(prNumber)} has more than 100 review threads — only the first 100 were scanned for stale bot comments\n`,
    );
  }
  return ids;
};

// Best-effort: a minimize failure is logged, never fails the post.
const minimizeComments = async (
  prNumber: number,
  ids: readonly string[],
  ghApi: GhApi,
): Promise<void> => {
  let minimized = 0;
  for (const id of ids) {
    try {
      await ghApi(["graphql", "-f", `query=${MINIMIZE_COMMENT_MUTATION}`, "-f", `id=${id}`]);
      minimized += 1;
    } catch (err) {
      process.stderr.write(
        `Warning: failed to minimize a stale review comment on PR #${String(prNumber)}: ${errMsg(err)}\n`,
      );
    }
  }
  if (minimized > 0) {
    process.stderr.write(
      `Minimized ${String(minimized)} stale inline comment(s) from superseded reviews on PR #${String(prNumber)}\n`,
    );
  }
};

export const post = async (input: PostInput, ghApi: GhApi = runGhApi): Promise<void> => {
  // Phase 1: reads + rendering, no writes yet.
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

  const prices = JSON.parse(readFileSync(input.pricesPath, "utf-8")) as unknown;
  const decodedPrices = PriceMapCodec.decode(prices);
  if (decodedPrices._tag === "Left") {
    throw new Error(`Price map at ${input.pricesPath} does not match the expected shape`);
  }
  const template = readFileSync(input.templatePath, "utf-8");
  const inlineTemplate = readFileSync(input.inlineTemplatePath, "utf-8");

  const renderNotice = (message: string): string =>
    formatMarkdown(
      render({
        findings: noticeFindings(`### ⚠️ ${message}`),
        envelope: null,
        prices: decodedPrices.right,
        pricesProvided: input.pricesProvided,
        template,
        route: input.route,
        reviewedSha: input.headSha,
        effort: input.effort,
        runUrl: input.runUrl,
        jsonUrl: input.jsonUrl,
        postedAt: input.postedAt,
      }),
    );

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
    const body = formatMarkdown(
      render({
        findings,
        envelope: null,
        prices: decodedPrices.right,
        pricesProvided: input.pricesProvided,
        template,
        route: input.route,
        reviewedSha: input.headSha,
        effort: input.effort,
        testReport,
        inlineDisposition: { kind: "no-envelope" },
        runUrl: input.runUrl,
        jsonUrl: input.jsonUrl,
        postedAt: input.postedAt,
      }),
    );
    await upsertSticky(input.repo, prNumber, existingSticky, body, ghApi);
    process.stderr.write(
      "Result envelope missing or malformed — posted sticky summary without usage/cost data; no inline review\n",
    );
    process.exit(0);
  }

  // Base64-encode the whole-document marker once, reused across sticky + review body; each inline
  // comment embeds only its own finding instead.
  const findingsMarker = findingsPointer(findings, input.jsonUrl);

  const {
    comments: rawComments,
    strays,
    inDiff,
  } = buildInlineComments(findings.findings, diff, {
    inlineTemplate,
    models: envelope.models.map((m) => m.model),
    findings,
    jsonUrl: input.jsonUrl,
  });
  const { comments, longFiles } = checkLongSuggestions(rawComments);
  for (const wf of longFiles) {
    process.stderr.write(
      `Warning: suggestion in ${wf} exceeds ${String(MAX_SUGGESTION_LINES)} lines — omitted from inline to avoid 422\n`,
    );
  }

  // All prior bot reviews, fetched to supersede below — a re-run on the same commit still posts a
  // fresh review rather than being skipped.
  const botReviews = await fetchBotReviews(input.repo, prNumber, input.botLogin, ghApi);

  // The "posted" disposition is only ever built from the actual post result below, never optimistically.
  const initialDisposition: InlineDisposition | undefined =
    comments.length === 0 && strays.length > 0 ? { kind: "none-in-diff" } : undefined;

  const commonRenderInput: Omit<RenderInput, "inlineDisposition" | "reviewUrl"> = {
    findings,
    envelope,
    prices: decodedPrices.right,
    pricesProvided: input.pricesProvided,
    template,
    route: input.route,
    reviewedSha: input.headSha,
    effort: input.effort,
    testReport,
    severityCounts: computeSeverityCounts(findings.findings),
    strays,
    runUrl: input.runUrl,
    jsonUrl: input.jsonUrl,
    findingsPointer: findingsMarker,
    postedAt: input.postedAt,
  };
  const longFilesNote =
    longFiles.length > 0
      ? `\n\n---\n\n> **Note:** ${String(longFiles.length)} suggestion(s) exceeded GitHub's ~10-line inline suggestion limit and were omitted from the inline comments; the affected findings remain in the review.\n`
      : "";
  // Called twice: before the review exists (no disposition claim) and after (with reviewUrl + truth).
  const renderBody = (
    inlineDisposition: InlineDisposition | undefined,
    reviewUrl?: string,
    straysOverride?: readonly Finding[],
    unanchoredCount?: number,
  ): string =>
    formatMarkdown(
      render({
        ...commonRenderInput,
        ...(straysOverride ? { strays: straysOverride } : {}),
        ...(unanchoredCount !== undefined ? { unanchoredCount } : {}),
        inlineDisposition,
        reviewUrl,
      }) + longFilesNote,
    );

  // Phase 2: writes — sticky first, inline second.
  const stickyRef = await upsertSticky(
    input.repo,
    prNumber,
    existingSticky,
    renderBody(initialDisposition),
    ghApi,
  );

  // Snapshot stale comments BEFORE posting the fresh ones; timing (not commit SHA) separates them.
  const priorInlineComments = await listPriorBotCommentIds(
    input.repo,
    prNumber,
    input.botLogin,
    ghApi,
  );

  // Post first, THEN dismiss: the PR is never left review-less if the process dies between the two.
  const {
    url: reviewUrl,
    inlinePosted,
    unposted,
  } = await postInlineReview(
    input.repo,
    prNumber,
    input.headSha,
    comments,
    inDiff,
    stickyRef?.url,
    findingsMarker,
    ghApi,
  );
  process.stderr.write(
    `Posted a review with ${String(inlinePosted)} inline comment(s) on PR #${String(prNumber)}\n`,
  );

  // Best-effort: a failed dismissal leaves a stale review beside the fresh one (logged), not a job failure.
  const priorReviewIds = botReviews.map((r) => r.id);
  if (priorReviewIds.length > 0) {
    await dismissReviews(input.repo, prNumber, priorReviewIds, ghApi);
  }

  // Minimize the pre-post snapshot (stale threads); the fresh comments were posted after it, untouched.
  await minimizeComments(prNumber, priorInlineComments, ghApi);

  // Re-render the sticky to the truth: "posted N" is the count that ACTUALLY anchored, any
  // GitHub-rejected in-diff findings join the strays, and none-anchored says "inline unavailable",
  // never a false "posted". Best-effort — the sticky and review are already posted.
  const unanchoredCount = unposted.length;
  const finalStrays = unanchoredCount > 0 ? [...unposted, ...strays] : strays;
  if (stickyRef !== null && (inlinePosted > 0 || unanchoredCount > 0)) {
    const finalDisposition: InlineDisposition =
      inlinePosted > 0
        ? { kind: "posted", count: inlinePosted, sha: input.headSha }
        : { kind: "inline-unavailable" };
    try {
      await patchComment(
        input.repo,
        stickyRef.id,
        renderBody(finalDisposition, reviewUrl, finalStrays, unanchoredCount),
        ghApi,
      );
      process.stderr.write(
        `Updated sticky comment #${String(stickyRef.id)} to reflect the review\n`,
      );
    } catch (err) {
      process.stderr.write(
        `Warning: failed to update the sticky summary after the review: ${errMsg(err)}\n`,
      );
    }
  }
};
