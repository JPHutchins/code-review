// Ordering invariant: all reads, decodes, and rendering complete before the first API write; then
// the sticky, then the inline review. A posting failure propagates and exits non-zero (never partial).

import { readFileSync } from "node:fs";
import type { InlineComment, InlineDisposition, RenderInput } from "./types.js";
import { buildInlineComments } from "./inline.js";
import { isEmptyDiff } from "./diff.js";
import {
  render,
  computeSeverityCounts,
  computeRoundCounts,
  isConvergenceRound,
  isReviewVerdict,
} from "./render.js";
import { formatMarkdown } from "./format.js";
import {
  carryForwardMarkers,
  findingsMarkerForm,
  isFullReviewSticky,
  parseCompletedAncestor,
  parseFindingsMarker,
  parseReviewComplete,
  parseReviewedRoute,
  parseReviewedSha,
  parseRounds,
  parseSignalMarker,
  parseSurfaceSignal,
  reviewBodyPointer,
  signalForRound,
  signalMarker,
  surfaceFindings,
  surfacedFindingsPointer,
} from "./surface.js";
import type { SurfaceSignal } from "./surface.js";
import {
  ResultEnvelopeCodec,
  PriceMapCodec,
  TestSummaryCodec,
  incompleteFindings,
  isIncompleteFindings,
} from "./schema.js";
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
  // Advisory convergence tolerance passed through to render(); omitted ⇒ the render default.
  readonly convergenceThreshold?: number;
  // Computed by the caller via formatUtc so post() stays a clockless pass-through into render().
  readonly postedAt?: string;
}

const DEFAULT_MARKER = "<!-- code-review -->";
const EMPTY_MECHANIC_LEAVE_MESSAGE =
  "The CI-fix pass found no issues and the sticky already reflects a completed full review — leaving it in place\n";
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

  // An incomplete result (a notice, not a completed review) must never overwrite a sticky that
  // already shows a completed review — else a superseded/killed/late run buries a real review under a
  // "did not complete" that reads as a clean pass. A completed result always writes; an in-progress
  // placeholder is not "complete" (it lacks the marker), so its own commenter may still write.
  const existingComplete = existingSticky !== null && parseReviewComplete(existingSticky.body);
  const wouldBuryCompleted = (incomplete: boolean): boolean => incomplete && existingComplete;

  // "The sticky reflects a completed FULL review": the isFullReviewSticky predicate (route marker
  // wins, round history as the pre-marker fallback), plus, for a sticky with no route or round
  // signal at all, the two completed-review signals of the pre-marker era — review-complete on the
  // sticky itself, or the announce placeholder's carried completed-ancestor marker (a notice can
  // never carry either). This deliberately does NOT require review-complete: the announce
  // placeholder strips it while preserving the route and round markers, and an empty mechanic must
  // not bury the full review the placeholder still records.
  const priorIsFullReview = (body: string): boolean =>
    isFullReviewSticky(body) ||
    (parseReviewedRoute(body) === null &&
      (parseReviewComplete(body) || parseCompletedAncestor(body)));

  // An EMPTY CI-fix mechanic pass must not bury a completed FULL review either: it completes with
  // genuinely empty findings ({verdict: "comment", findings: []}), so it is not "incomplete" and
  // wouldBuryCompleted can't see it — yet replacing a full review's sticky with "No findings — clean
  // review." is the same false clean pass class (issue #127). A mechanic WITH findings still
  // supersedes (its fixes are the actionable output on a red CI). The route comes from the review
  // job (passed through as --route; the envelope is the fallback for standalone callers), so the
  // guard also fires when the result envelope was lost in transit.
  const emptyMechanicWouldBury = (route: string | null | undefined, incomplete: boolean): boolean =>
    route === "mechanic" &&
    !incomplete &&
    findings.findings.length === 0 &&
    existingSticky !== null &&
    priorIsFullReview(existingSticky.body);

  // The full-review convergence history carried in the sticky's marker (it survives the announce
  // placeholder via carryForwardMarkers). A completed FULL review appends this run's counts below; a
  // CI-fix mechanic pass and every notice carry it forward unchanged so the trajectory is never lost.
  const priorRounds = existingSticky !== null ? parseRounds(existingSticky.body) : [];
  // The last completed round's stop signal, carried VERBATIM into non-round posts — re-deriving it
  // at the current threshold would flip a prior round's `converged` when the operator changes
  // convergence_threshold mid-PR. Read from the compact signal marker first (an oversized prior
  // review embeds only that), then from the surfaced blob. Null when the prior sticky has neither or
  // no round has completed (the blob then carries no signal, exactly like a first-run post).
  const priorSignal =
    existingSticky === null
      ? null
      : (parseSignalMarker(existingSticky.body) ??
        parseSurfaceSignal(parseFindingsMarker(existingSticky.body)));

  // A post whose blob embeds no signal (a notice — any error-verdict doc) still preserves the prior
  // round's stop signal on the sticky in the compact marker, so the next post reads it back via
  // parseSignalMarker: the notice itself never claims a signal, but a completed round's `converged`
  // is not erased by a failed run (issue #141 review r3).
  const findingsMarkerFor = (findings: Findings, signal: SurfaceSignal | null): string => {
    const pointer = surfacedFindingsPointer(findings, signal, input.jsonUrl);
    return signal !== null || priorSignal === null
      ? pointer
      : `${pointer}\n${signalMarker(priorSignal)}`;
  };
  const leaveInPlace = (message?: string): never => {
    process.stderr.write(
      message ??
        "Review did not complete and the sticky already reflects a completed review — leaving it in place\n",
    );
    process.exit(0);
  };

  // When the guard fires on a real completed review, leaving it in place is right — it IS the
  // terminal content. When it fires on the announce PLACEHOLDER (which strips review-complete), a
  // bare leave would strand a stale "Code review in progress" as the terminal state, so post a
  // compact honest notice instead, carrying the preserved full review's markers forward so the seed
  // chain and trajectory survive the swap. Callers pass the sticky the guard already established
  // exists (TS can't see the closure's narrowing).
  const emptyMechanicLeaveOrNote = async (sticky: {
    readonly id: number;
    readonly body: string;
  }): Promise<void> => {
    if (existingComplete) leaveInPlace(EMPTY_MECHANIC_LEAVE_MESSAGE);
    const priorSha = parseReviewedSha(sticky.body);
    const body = formatMarkdown(
      `${DEFAULT_MARKER}\n\n⚠️ **CI-fix pass completed with no findings** for \`${input.headSha.slice(0, 7)}\` — the completed full review of \`${priorSha ? priorSha.slice(0, 7) : "an earlier commit"}\` is preserved below.\n\n${carryForwardMarkers(sticky.body)}`,
    );
    await upsertSticky(input.repo, prNumber, sticky, body, ghApi);
    process.exit(0);
  };

  const prices = JSON.parse(readFileSync(input.pricesPath, "utf-8")) as unknown;
  const decodedPrices = PriceMapCodec.decode(prices);
  if (decodedPrices._tag === "Left") {
    throw new Error(`Price map at ${input.pricesPath} does not match the expected shape`);
  }
  const template = readFileSync(input.templatePath, "utf-8");
  const inlineTemplate = readFileSync(input.inlineTemplatePath, "utf-8");

  const renderNotice = (message: string): string => {
    const findings = incompleteFindings(`### ⚠️ ${message}`);
    return formatMarkdown(
      render({
        findings,
        envelope: null,
        incomplete: true,
        prices: decodedPrices.right,
        pricesProvided: input.pricesProvided,
        template,
        route: input.route,
        reviewedSha: input.headSha,
        effort: input.effort,
        rounds: priorRounds,
        roundCount: priorSignal?.round ?? priorRounds.length,
        convergenceRound: false,
        runUrl: input.runUrl,
        jsonUrl: input.jsonUrl,
        // A notice's own blob stays clean: verdict "error" + a carried "converged" would read as a
        // stop signal for a run that produced no verdict (issue #141 review r2). The prior signal
        // survives on the sticky in the compact marker (findingsMarkerFor), and the carried-forward
        // trajectory (rounds marker) remains the historical record.
        findingsPointer: findingsMarkerFor(findings, null),
        postedAt: input.postedAt,
      }),
    );
  };

  if (isEmptyDiff(diff)) {
    if (wouldBuryCompleted(true)) leaveInPlace();
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
    if (wouldBuryCompleted(true)) leaveInPlace();
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

  // The route the review job stamped, read the same way render does — `input.route` first, then the
  // envelope — so the workflow's --route passthrough and standalone callers both work, and the
  // sticky's route marker, the guard, and the rounds logic can never disagree.
  const effectiveRoute = input.route ?? envelope?.route;

  if (envelope === null) {
    // The envelope carried the incomplete flag; with it lost, derive incompleteness from the verdict
    // (render does the same) so an error-verdict findings doc here still reads as a notice and — via
    // the guard below — can't bury a completed review, which this branch previously skipped.
    const envelopelessIncomplete = isIncompleteFindings(findings);
    if (wouldBuryCompleted(envelopelessIncomplete)) leaveInPlace();
    // The route is passed through as --route, so an empty mechanic with a lost envelope still
    // cannot bury a completed full review (issue #127).
    if (emptyMechanicWouldBury(effectiveRoute, envelopelessIncomplete) && existingSticky !== null)
      await emptyMechanicLeaveOrNote(existingSticky);
    const body = formatMarkdown(
      render({
        findings,
        envelope: null,
        incomplete: envelopelessIncomplete,
        prices: decodedPrices.right,
        pricesProvided: input.pricesProvided,
        template,
        route: effectiveRoute,
        reviewedSha: input.headSha,
        effort: input.effort,
        rounds: priorRounds,
        roundCount: priorSignal?.round ?? priorRounds.length,
        convergenceRound: false,
        testReport,
        inlineDisposition: { kind: "no-envelope" },
        runUrl: input.runUrl,
        jsonUrl: input.jsonUrl,
        // Same signal rule as the main path: only a completed-review doc carries the prior signal
        // in its blob; an error-verdict doc preserves it in the compact marker instead.
        findingsPointer: findingsMarkerFor(
          findings,
          isReviewVerdict(findings.verdict) ? priorSignal : null,
        ),
        postedAt: input.postedAt,
      }),
    );
    await upsertSticky(input.repo, prNumber, existingSticky, body, ghApi);
    process.stderr.write(
      "Result envelope missing or malformed — posted sticky summary without usage/cost data; no inline review\n",
    );
    process.exit(0);
  }

  // A completed review carries real telemetry; adapt (and the workflow's notice wrap) flag a run that
  // produced only a notice. Don't let such a notice bury an existing completed review or post a stray
  // empty inline review over it — leave the real review in place.
  const thisIncomplete = envelope.incomplete === true || isIncompleteFindings(findings);
  if (wouldBuryCompleted(thisIncomplete)) leaveInPlace();

  if (emptyMechanicWouldBury(effectiveRoute, thisIncomplete) && existingSticky !== null)
    await emptyMechanicLeaveOrNote(existingSticky);

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

  const currentCounts = computeSeverityCounts(findings.findings);

  // A convergence round is a COMPLETED FULL review (effectiveRoute read above — `input.route` first,
  // then the envelope — the same way render does). A mechanic pass or any incomplete/failed run
  // carries the trajectory forward unchanged (it is a CI fix or a non-review, not a round). The
  // verdict guard (isReviewVerdict, render's badge uses the same predicate) also gates the append
  // here, so an out-of-contract "error" verdict that somehow carries findings never counts as a
  // round: the trajectory, the badge, and the blob's convergence stay one decision. A same-head CI
  // retry simply appends again — an identical chip reads as "no change", which is accurate; a
  // reviewed-sha-keyed replace is unsafe because a mechanic stamps a new head without adding a
  // round, so the last round need not be its head.
  const isRound =
    isConvergenceRound(effectiveRoute, thisIncomplete) && isReviewVerdict(findings.verdict);
  // The round entry carries the ROUND counts (findings + systemic severities) — the same
  // computeRoundCounts the badge scores with, so a systemic-only round with a critical systemic item
  // stores and shows 🔴1 rather than masquerading as "clean".
  const rounds = isRound ? [...priorRounds, computeRoundCounts(findings)] : priorRounds;

  // The stop signal the surfaced blob embeds: THIS round's signal when the run completes a round,
  // else the prior round's signal carried verbatim (see priorSignal above) — never re-derived. An
  // incomplete run or a no-verdict doc embeds NO signal: a carried "converged" beside "no review
  // verdict" (or beside a run the envelope says did not complete) would read as a stop signal for a
  // run that produced none (issue #141 reviews r2 + r4). The round number can never regress: the
  // rounds marker is best-effort (parseRounds filters corrupt entries), so a completing round
  // numbers itself after the carried count when it is ahead.
  const signal = isRound
    ? signalForRound(
        Math.max(priorSignal?.round ?? priorRounds.length, priorRounds.length) + 1,
        computeRoundCounts(findings),
        input.convergenceThreshold,
      )
    : thisIncomplete || !isReviewVerdict(findings.verdict)
      ? null
      : priorSignal;

  // Base64-encode the SURFACED whole-document marker once (the agent's doc + the stop signal),
  // reused across sticky + review body; each inline comment embeds only its own finding instead.
  const findingsMarker = findingsMarkerFor(findings, signal);

  // Only the embedded base64 form is decodable back by a re-review seed (parseFindingsMarker), so a
  // degraded marker would silently drop the embedded machine channel — surface the degradation in
  // the run log rather than letting it vanish. The link form still carries a machine-readable
  // pointer; only the omitted form loses the channel entirely. Measured on the SURFACED marker
  // (surfaceFindings — the agent's doc plus the stop signal), which is the form actually embedded.
  const markerForm = findingsMarkerForm(surfaceFindings(findings, signal), input.jsonUrl);
  if (markerForm === "link") {
    process.stderr.write(
      "Warning: the findings-json marker exceeds the embed limit — degraded to the jsonUrl-link form; a decoding agent must fetch the artifact instead of the embedded JSON\n",
    );
  } else if (markerForm === "omitted") {
    process.stderr.write(
      "Warning: the findings-json marker exceeds the embed limit and no --json-url was given — the machine-readable channel is omitted from the posted surfaces\n",
    );
  }

  const commonRenderInput: Omit<RenderInput, "inlineDisposition" | "reviewUrl"> = {
    findings,
    envelope,
    incomplete: thisIncomplete,
    prices: decodedPrices.right,
    pricesProvided: input.pricesProvided,
    template,
    route: effectiveRoute,
    reviewedSha: input.headSha,
    effort: input.effort,
    testReport,
    severityCounts: currentCounts,
    rounds,
    roundCount: signal?.round ?? priorSignal?.round ?? priorRounds.length,
    convergenceThreshold: input.convergenceThreshold,
    convergenceRound: isRound,
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

export interface AnnounceInput {
  readonly repo: string;
  readonly headSha: string;
  readonly botLogin: string;
  readonly runUrl: string;
  readonly headBranch?: string;
}

// The placeholder body: the sticky marker, a "review in progress" line linking the run, and — when a
// prior sticky exists — its machine-readable markers carried forward verbatim, so replacing the
// summary prose never strips the re-review seed the review job reads back (embedded findings +
// reviewed-sha). The commenter job overwrites this with the real summary when the review completes.
const announceBody = (
  headSha: string,
  runUrl: string,
  existingBody: string | undefined,
): string => {
  const notice = `${DEFAULT_MARKER}\n\n🔄 **Code review in progress** for \`${headSha.slice(0, 7)}\` — see the [workflow run](${runUrl}) for progress; this comment is updated with the review when it completes.`;
  const carried = existingBody ? carryForwardMarkers(existingBody) : "";
  return carried ? `${notice}\n\n${carried}` : notice;
};

// Post (or update) the sticky the moment a review starts, so a workflow_run review — which runs from
// the default branch and is otherwise invisible on the PR — is visibly under way. Shares post's PR
// resolution and sticky upsert; the review job holds no write token, so it can't do this itself.
export const announce = async (input: AnnounceInput, ghApi: GhApi = runGhApi): Promise<void> => {
  const candidates = await fetchPrCandidates(input.repo, input.headSha, ghApi);
  const resolution = resolvePr(candidates, input.headBranch);
  if (resolution.kind !== "open") {
    process.stderr.write(
      `No open PR for ${input.headSha} — nothing to announce (${resolution.kind})\n`,
    );
    return;
  }
  const existing = await findBotComment(
    input.repo,
    resolution.prNumber,
    input.botLogin,
    DEFAULT_MARKER,
    ghApi,
  );
  // If the sticky already reflects a COMPLETED review OF THIS HEAD, leave it — overwriting it with the
  // in-progress placeholder would hide a finished review (a CI re-run of an already-reviewed commit,
  // or the review+comment pipeline racing ahead of this job). Both conditions matter: a same-head
  // INCOMPLETE notice (which also stamps reviewed-sha) must be replaced by the placeholder on a re-run,
  // and a prior head's sha still gets replaced regardless. `review-complete` is the discriminator the
  // commenter guard uses too, so both write paths agree on what "completed" means.
  if (
    existing !== null &&
    parseReviewComplete(existing.body) &&
    parseReviewedSha(existing.body) === input.headSha.toLowerCase()
  ) {
    process.stderr.write(
      `Sticky already reflects a completed review of ${input.headSha} — leaving it in place\n`,
    );
    return;
  }
  await upsertSticky(
    input.repo,
    resolution.prNumber,
    existing,
    announceBody(input.headSha, input.runUrl, existing?.body),
    ghApi,
  );
};

const incompleteBody = (
  headSha: string,
  runUrl: string,
  existingBody: string | undefined,
): string => {
  const notice = `${DEFAULT_MARKER}\n\n⚠️ **Code review did not complete** for \`${headSha.slice(0, 7)}\` — the review job failed ([run](${runUrl})). Re-request the review; do not treat this round as spent.`;
  const carried = existingBody ? carryForwardMarkers(existingBody) : "";
  return carried ? `${notice}\n\n${carried}` : notice;
};

// The human-readable half of failure attribution (the check-run is the machine half): a review that
// died leaves NO comment, so a separate always()-job posts this. Shares announce's PR resolution and
// sticky upsert; the guard is stronger — it never buries a completed review OF ANY head, so a failed
// run reporting late (after a superseding run already finished) can't clobber the real review.
export const reportIncomplete = async (
  input: AnnounceInput,
  ghApi: GhApi = runGhApi,
): Promise<void> => {
  const candidates = await fetchPrCandidates(input.repo, input.headSha, ghApi);
  const resolution = resolvePr(candidates, input.headBranch);
  if (resolution.kind !== "open") {
    process.stderr.write(
      `No open PR for ${input.headSha} — nothing to report (${resolution.kind})\n`,
    );
    return;
  }
  const existing = await findBotComment(
    input.repo,
    resolution.prNumber,
    input.botLogin,
    DEFAULT_MARKER,
    ghApi,
  );
  if (existing !== null && parseReviewComplete(existing.body)) {
    process.stderr.write(`Sticky already reflects a completed review — leaving it in place\n`);
    return;
  }
  // The sticky exists but is NOT this run's own placeholder — it belongs to a superseding run whose
  // announce already posted a live "in progress" for a newer head. Overwriting it with "did not
  // complete" would be a false alarm for a review that is actively running. This run's own placeholder
  // (or a prior failure notice this run posted) embeds this run's URL, so its presence is the signal
  // that overwriting is safe.
  if (existing !== null && !existing.body.includes(input.runUrl)) {
    process.stderr.write(`Sticky belongs to another run — leaving it in place\n`);
    return;
  }
  await upsertSticky(
    input.repo,
    resolution.prNumber,
    existing,
    incompleteBody(input.headSha, input.runUrl, existing?.body),
    ghApi,
  );
};
