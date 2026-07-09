// Deterministic GH posting: resolve PR, fetch diff, run inline, post inline review,
// render summary, upsert sticky comment. Pure core with a thin gh-api effect.
//
// Ordering (CO-R3): all reads, decodes, diff validation, and rendering complete before
// the first API write; then the sticky is posted, and the inline review second. A posting
// failure propagates and exits the process non-zero (never partially posts).

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

export interface PostInput {
  readonly repo: string;
  readonly headSha: string;
  readonly botLogin: string;
  readonly findingsPath: string;
  readonly envelopePath: string;
  readonly pricesPath: string;
  /** Whether `pricesPath` is a real caller-supplied price map or the bundled all-zero example
   *  standing in for an absent one — threaded to the render layer so cost shows N/A, not a false
   *  $0.00, when absent (SPEC §6.2). */
  readonly pricesProvided: boolean;
  readonly templatePath: string;
  readonly inlineTemplatePath: string;
  /** Overrides the envelope's route (SPEC §6.1) when set; otherwise the envelope is the source. */
  readonly route?: string;
  readonly headBranch?: string;
  readonly testReportPath?: string;
  readonly effort?: string;
  /** Workflow run URL, threaded into the sticky's LLM Disclosure aside (SPEC §5.1 item 6). */
  readonly runUrl?: string;
  /** Findings-json artifact URL — the marker's fallback on every surface (sticky, each inline
   *  comment, and the review body itself) when the embedded form is too large (SPEC §5.1 item 7,
   *  §5.2, issue #19). */
  readonly jsonUrl?: string;
  /** Preformatted UTC post time, leading the sticky's "**Reviewed** `<sha>` at <postedAt>" meta
   *  segment (issue #28) — computed by the caller (index.ts's post command) via `formatUtc`, not here,
   *  so `post()` stays a thin, testable pass-through of the timestamp into `render()`. */
  readonly postedAt?: string;
}

const DEFAULT_MARKER = "<!-- code-review -->";
const MAX_SUGGESTION_LINES = 10;

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

/** Parse an `html_url` field out of a `gh api` JSON response; a malformed or unexpected response
 *  degrades to undefined rather than throwing — a missing link must never fail the post (§5.5). */
const parseHtmlUrl = (raw: string): string | undefined => {
  try {
    const parsed = JSON.parse(raw) as { html_url?: unknown };
    return typeof parsed.html_url === "string" ? parsed.html_url : undefined;
  } catch {
    return undefined;
  }
};

/** A single comment's position payload, shared by the batched review POST and the per-comment
 *  salvage POST below. */
const commentPayload = (c: InlineComment): Record<string, unknown> => ({
  path: c.path,
  line: c.line,
  side: c.side,
  ...(c.start_line !== undefined && c.start_side !== undefined
    ? { start_line: c.start_line, start_side: c.start_side }
    : {}),
  body: formatMarkdown(c.body),
});

/** Post the inline review, pointing its body at the sticky (issue #11) when the sticky's URL is
 *  known, and prepending the precomputed findings-json marker (issue #19) so the review body carries
 *  it too. `comments[i]` is the rendered comment for finding `inDiff[i]` (1:1, same order). Returns
 *  the review's `html_url` (undefined on a malformed response), how many inline comments actually
 *  posted, and the findings whose comment GitHub rejected — so the caller can surface exactly those
 *  in the sticky (issue #57) and keep the disposition count truthful (issue #21). */
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
    // The reviews endpoint is atomic: one comment on a position GitHub won't accept rejects the WHOLE
    // batch (issue #57). Rather than fail the job — or drop every comment — post the review body-only
    // (so the event + findings marker exist) and then re-post each comment individually, keeping the
    // ones GitHub accepts and collecting the finding behind each one it rejects for the caller to
    // surface in the sticky. Degrade, never crash (§5.5). A body-only review that itself fails
    // (comments.length === 0) is a genuine error and propagates.
    if (comments.length === 0) throw err;
    process.stderr.write(
      `Warning: the batched inline review on PR #${String(prNumber)} was rejected (${err instanceof Error ? err.message : String(err)}) — GitHub rejects the whole batch if any one comment's position is invalid; posting the review body-only, then each comment individually to keep the valid ones (issue #57)\n`,
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
          `Warning: inline comment on ${c.path}:${String(c.line)} rejected (${e instanceof Error ? e.message : String(e)}) — surfacing that finding in the sticky instead (issue #57)\n`,
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

/** Parse an issue-comment create/patch response for `id`/`html_url`; malformed responses degrade
 *  to null rather than throwing (§5.5, issue #11 ROBUSTNESS — a missing link must never fail the
 *  post). */
const parseCommentRef = (
  raw: string,
): { readonly id: number; readonly html_url: string } | null => {
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; html_url?: unknown };
    return typeof parsed.id === "number" && typeof parsed.html_url === "string"
      ? { id: parsed.id, html_url: parsed.html_url }
      : null;
  } catch {
    return null;
  }
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
  // Only `html_url` is needed here — the id is already known by the caller — so this doesn't
  // require `id` in the response the way parseCommentRef (used for a brand-new comment) does.
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

/** Upsert the sticky summary — trust by author identity (bot login), not marker alone (§5.3).
 *  Returns the sticky's id + `html_url` (url undefined on a malformed response) so the caller can
 *  re-patch it with a link to the review once posted (issue #11). Returns null only when a *new*
 *  comment's response couldn't be parsed at all — there is then no id to re-patch with. */
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

/** A non-dismissed bot-authored review. Only its id is needed — every prior bot review is
 *  superseded regardless of which commit it reviewed (issue #53). */
interface BotReviewRef {
  readonly id: number;
}

const isBotReview = (r: unknown): r is { id: number; user: { login: string }; state: string } =>
  typeof r === "object" &&
  r !== null &&
  typeof (r as { id?: unknown }).id === "number" &&
  typeof (r as { state?: unknown }).state === "string" &&
  typeof (r as { user?: { login?: unknown } }).user?.login === "string";

/** List the PR's non-dismissed bot-authored reviews. */
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

/** Dismiss superseded bot-authored reviews (REC-CO-2). Failures are logged, never fail the job. */
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
        `Warning: failed to dismiss prior review #${String(id)} on PR #${String(prNumber)}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
};

/** GraphQL: list a PR's review-thread comments — author + whether already minimized — enough to find
 *  the bot's own inline comments left by prior reviews. Capped at the first 100 threads (×100 comments
 *  each); `pageInfo.hasNextPage` flags a PR that exceeds the cap. */
const REVIEW_THREAD_COMMENTS_QUERY =
  "query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){pageInfo{hasNextPage}nodes{comments(first:100){nodes{id isMinimized author{login}}}}}}}}";

/** GraphQL: hide one comment as OUTDATED. Reversible — minimized, not deleted. */
const MINIMIZE_COMMENT_MUTATION =
  "mutation($id:ID!){minimizeComment(input:{subjectId:$id,classifier:OUTDATED}){minimizedComment{isMinimized}}}";

/** The comment's node id when it is a bot-authored, not-yet-minimized inline comment; null otherwise.
 *  GraphQL reports the bare login (`github-actions`), so the bot login is matched with and without the
 *  REST `[bot]` suffix. Which SHA it was authored against no longer matters — the caller snapshots the
 *  set BEFORE posting the fresh review, so every match is by definition a prior (stale) comment. Pure. */
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

/** Parse the review-threads response into the bot's not-yet-minimized inline comment ids, degrading
 *  to an empty list on any malformed shape (§5.5), and flagging whether the 100-thread cap was hit.
 *  Pure. */
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

/** Snapshot the bot's own not-yet-minimized inline review comments currently on the PR — the stale
 *  threads left by prior reviews (issue #31/#53). Called BEFORE the fresh review is posted, so the set
 *  is exactly the prior comments (whether on a superseded commit or an earlier review of this same
 *  SHA) and never the fresh ones. Best-effort: any listing failure logs and returns []. */
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
      `Warning: could not list review threads to minimize stale comments on PR #${String(prNumber)}: ${err instanceof Error ? err.message : String(err)}\n`,
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

/** Minimize (as OUTDATED, reversibly) the given bot inline comment node ids — the pre-post snapshot of
 *  stale threads — so a re-reviewed PR doesn't accumulate them (issue #31/#53). Best-effort: any
 *  minimize failure is logged and never fails the post. */
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
        `Warning: failed to minimize a stale review comment on PR #${String(prNumber)}: ${err instanceof Error ? err.message : String(err)}\n`,
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

  // Issue #19 + review fix #5: base64-encode the whole-document marker ONCE and reuse it on the two
  // single-per-review surfaces (both sticky renders, the review body). Each inline comment instead
  // embeds only its OWN finding (issue #31) — buildInlineComments derives that per-finding marker
  // itself from `findings` below, rather than reusing this whole-document one.
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

  // The bot's prior reviews (identity via the reviews API `commit_id`), fetched to supersede every
  // one of them — including any already on THIS head SHA — before posting the fresh review below.
  // We ran the review agent and paid for it, so its result must be surfaced: a re-request (or an
  // incidental CI re-run) on the same commit dismisses the stale review and posts the new one rather
  // than being skipped (issue #53). Fetched unconditionally now that a review is always posted (#43).
  const botReviews = await fetchBotReviews(input.repo, prNumber, input.botLogin, ghApi);

  // Issue #21: the "posted — see the review" disposition is constructed ONLY from the actual
  // postInlineReview result below, never optimistically — a review that doesn't yet exist (or
  // never will, if this process dies before posting it) must never be claimed. Everything knowable
  // from reads alone (no-in-diff-findings) is truthful up front and stays as-is.
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
  // Renders the sticky body; called twice (issue #11) — once before the review exists (no
  // disposition claim beyond what reads already confirmed), once after (with the confirmed
  // disposition + reviewUrl) to report the truth and link the sticky back to the review.
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

  // Phase 2 (CO-R3): writes — sticky first, inline second; failure exits non-zero.
  const stickyRef = await upsertSticky(
    input.repo,
    prNumber,
    existingSticky,
    renderBody(initialDisposition),
    ghApi,
  );

  // Issue #43: a COMMENT review is posted on EVERY run, even with no in-diff comments, so tooling and
  // agents get a review event every time — its body points at the sticky (for humans) and carries the
  // findings-JSON marker (for agents).

  // Issue #31/#53: snapshot the bot's existing inline comments BEFORE posting the fresh review, so the
  // stale ones can be minimized afterward without touching the fresh ones. Timing — not the comment's
  // commit SHA — separates stale from fresh: everything present now is from a prior review (on a
  // superseded commit OR an earlier review of this same SHA); the fresh comments are posted below.
  const priorInlineComments = await listPriorBotCommentIds(
    input.repo,
    prNumber,
    input.botLogin,
    ghApi,
  );

  // Post the fresh review FIRST, THEN supersede the prior ones (REC-CO-2 + issue #53): posting before
  // dismissing means the PR is never left without a review even if the process dies between the two —
  // a re-review of the same commit dismisses the stale review only after its replacement exists.
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

  // Supersede EVERY prior bot review — those on other commits and any already on this head SHA.
  // Best-effort: a dismissal that fails leaves a stale review beside the fresh one (logged), which
  // beats failing the job now that the fresh review is already posted. Concurrent runs on the same
  // commit are bounded by the workflow's concurrency group; GitHub itself tolerates multiple reviews.
  const priorReviewIds = botReviews.map((r) => r.id);
  if (priorReviewIds.length > 0) {
    await dismissReviews(input.repo, prNumber, priorReviewIds, ghApi);
  }

  // Issue #31/#53: minimize the pre-post snapshot — the stale threads from the reviews just
  // superseded — so a re-reviewed PR doesn't accumulate them. The fresh review's comments were posted
  // after the snapshot, so they are untouched. Best-effort — the fresh review is already posted.
  await minimizeComments(prNumber, priorInlineComments, ghApi);

  // Issue #11/#21/#57: now that postInlineReview has resolved, re-render the sticky to the truth.
  // - `inlinePosted > 0` → "posted N" + the review link (N is the count that ACTUALLY posted, so a
  //   partial #57 salvage reports only the anchored ones).
  // - `unposted` (issue #57) → the in-diff findings GitHub rejected are appended to the real
  //   out-of-diff strays so no finding is lost to human view; `unanchoredCount` drives the section's
  //   note. When NONE anchored, the disposition says the inline surface was unavailable, never a
  //   false "posted" (issue #21).
  // - Neither → a body-only review with no in-diff comments (issue #43) keeps the initial sticky.
  // Best-effort — the sticky and review are already posted, so a failure here must never fail the job.
  const unanchoredCount = unposted.length;
  const finalStrays = unanchoredCount > 0 ? [...unposted, ...strays] : strays;
  const finalDisposition: InlineDisposition | undefined =
    inlinePosted > 0
      ? { kind: "posted", count: inlinePosted, sha: input.headSha }
      : unanchoredCount > 0
        ? { kind: "inline-unavailable" }
        : initialDisposition;
  if (stickyRef !== null && (inlinePosted > 0 || unanchoredCount > 0)) {
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
        `Warning: failed to update the sticky summary after the review: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
};
