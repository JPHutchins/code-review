// Ordering invariant: all reads, decodes, and rendering complete before the first API write; then
// the sticky, then the inline review. A posting failure propagates and exits non-zero (never partial).

import { readFileSync, appendFileSync } from "node:fs";
import type { InlineComment, InlineDisposition, RenderInput } from "./types.js";
import { buildInlineComments } from "./inline.js";
import { isEmptyDiff } from "./diff.js";
import { render, computeSeverityCounts, isConvergenceRound, isReviewVerdict } from "./render.js";
import { formatMarkdown } from "./format.js";
import {
  buildConvergence,
  carriedConvergence,
  carryForwardMarkers,
  computeCodeCounts,
  computeSameRootNotes,
  findingsMarkerPair,
  inProgressConvergence,
  nextRoundNumber,
  isBelowVisibilityFloor,
  isFullReviewSticky,
  priorBelowFloorNits,
  parseCompletedAncestor,
  parseFindingsMarker,
  parseReviewComplete,
  parseReviewedRoute,
  parseReviewedSha,
  priorTrajectory,
  reviewBodyPointer,
} from "./surface.js";
import {
  ResultEnvelopeCodec,
  PriceMapCodec,
  TestSummaryCodec,
  incompleteFindings,
  isIncompleteFindings,
  RECOVERABLE_OPTIONAL_FIELDS,
} from "./schema.js";
import type { Convergence, Finding, Findings, ResultEnvelope, TestSummary } from "./schema.js";
import { resolve, supportedVersions } from "./registry.js";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
import {
  findingsArtifactUrl,
  ghArtifactReader,
  hasFindingsMarker,
  resolvePriorFindings,
  type ArtifactReader,
} from "./artifact.js";
export type { GhApi } from "./gh.js";
import { fetchDiff, fetchPrCandidates, resolvePr } from "./pr.js";
import { runIdFromUrl } from "./checkrun.js";
import {
  applyAnswered,
  answeredNoteKey,
  answeredReRaiseNote,
  answeredRegistryFrom,
  fetchThreadComments,
} from "./answered.js";
import { asRecord, errMsg, tryParseJson } from "./util.js";

export interface PostInput {
  readonly repo: string;
  // The head repo (owner/name of the fork) threaded by the workflow via HEAD_REPO — a finding
  // permalink targets the tree the reviewed SHA lives in, which is the fork on a fork PR. Omitted
  // ⇒ the base repo (issue #231 r1).
  readonly headRepo?: string;
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
  // Raw `cloc --git --diff` table (issue #182), rendered verbatim in the sticky's cloc collapsible.
  readonly clocDiffPath?: string;
  readonly effort?: string;
  readonly runUrl?: string;
  // Render findings as inline review comments on the diff. Omitted/false ⇒ the review object is
  // posted body-only and the findings are listed in the sticky instead, which is the default because
  // an inline thread is a human-only surface that cannot be revised: a later round can neither update
  // nor resolve it, so stale threads accumulate on the diff (issue #179).
  readonly inline?: boolean;
  // The fast-fix route ran with no failing-job logs staged (issue #154). Passed as a flag because
  // this runs in the comment job, where the staged logs are not: the review job counted them. It
  // could equally ride the envelope, which `adapt` stamps with route and effort after the agent —
  // the flag is the same channel `--route` already uses, and works when the envelope is lost.
  readonly unverifiedNoLogs?: boolean;
  // Findings-json marker's fallback across surfaces when the embedded form is too large.
  readonly jsonUrl?: string;
  // Advisory convergence tolerance passed through to render(); omitted ⇒ the render default.
  readonly convergenceThreshold?: number;
  // The nit visibility floor (issue #164): nits below confidence × likelihood are hidden from humans.
  // Omitted ⇒ the surface default.
  readonly nitVisibilityFloor?: number;
  // Computed by the caller via formatUtc so post() stays a clockless pass-through into render().
  readonly postedAt?: string;
  // The run's UTC instant (same instant as postedAt), threaded to render for time-slotted pricing
  // (issue #170); post() stays clockless. Ignored for a flat price map.
  readonly pricedAt?: Date;
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

const decodeFindings = (doc: unknown): FindingsLoadResult => {
  const resolution = resolve("findings", doc);
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

const loadFindings = (path: string): FindingsLoadResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return { kind: "corrupt" };
  }
  const first = decodeFindings(raw);
  // The seed hands the agent a prior doc that carries `convergence`, and the agent is told not to write
  // it — but an echoed or mangled stamp must not fail the WHOLE review into a "did not complete" notice,
  // since the pipeline overwrites both stamped fields after load. Strip them and retry before degrading
  // (mirrors seed-draft's strip-and-retry, issue #185 review).
  if (
    first.kind === "invalid-shape" &&
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    Object.keys(raw).some((k) => RECOVERABLE_OPTIONAL_FIELDS.has(k))
  ) {
    const stripped = Object.fromEntries(
      Object.entries(raw).filter(([key]) => !RECOVERABLE_OPTIONAL_FIELDS.has(key)),
    );
    const retry = decodeFindings(stripped);
    if (retry.kind === "ok") {
      process.stderr.write(
        "Warning: the review draft carried an invalid best-effort field (convergence/scope_metastasis/change_size) — stripped it and used the rest; the pipeline re-stamps convergence\n",
      );
      return retry;
    }
  }
  return first;
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

// The raw cloc --diff table (issue #182), best-effort like loadTestReport: an unreadable path warns
// and omits the collapsible, and an empty/whitespace-only file (cloc ran but produced nothing, or a
// placeholder left by a failed run) is treated as absent so no empty collapsible renders.
export const loadClocDiff = (path: string): string | undefined => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    process.stderr.write(
      `Warning: could not read cloc diff at ${path}: ${errMsg(err)} — omitting the cloc collapsible\n`,
    );
    return undefined;
  }
  return raw.trim() === "" ? undefined : raw;
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
  pr: {
    readonly repo: string;
    readonly prNumber: number;
    readonly headSha: string;
    readonly stickyUrl: string | undefined;
    readonly runUrl: string | undefined;
  },
  comments: readonly InlineComment[],
  inDiff: readonly Finding[],
  ghApi: GhApi,
): Promise<{
  readonly url: string | undefined;
  readonly inlinePosted: number;
  readonly unposted: readonly Finding[];
}> => {
  const pointer = reviewBodyPointer(
    pr.headSha,
    pr.stickyUrl,
    pr.runUrl,
    (process.env["GITHUB_STEP_SUMMARY"] ?? "") !== "",
  );
  const reviewBody = (withComments: boolean): string =>
    JSON.stringify({
      body: pointer,
      commit_id: pr.headSha,
      event: "COMMENT",
      comments: withComments ? comments.map(commentPayload) : [],
    });
  const reviewsEndpoint = [`repos/${pr.repo}/pulls/${String(pr.prNumber)}/reviews`, "--input", "-"];
  try {
    const stdout = await ghApi(reviewsEndpoint, reviewBody(true));
    return { url: parseHtmlUrl(stdout), inlinePosted: comments.length, unposted: [] };
  } catch (err) {
    // The reviews endpoint is atomic — one rejected position fails the whole batch — so on rejection
    // post the body only, then re-post each comment individually, collecting the ones GitHub rejects.
    // A body-only review that itself fails (no comments) is a genuine error and propagates.
    if (comments.length === 0) throw err;
    process.stderr.write(
      `Warning: the batched inline review on PR #${String(pr.prNumber)} was rejected (${errMsg(err)}) — posting the review body-only, then each comment individually to keep the ones GitHub accepts (issue #57)\n`,
    );
    const url = parseHtmlUrl(await ghApi(reviewsEndpoint, reviewBody(false)));
    const commentsEndpoint = [
      `repos/${pr.repo}/pulls/${String(pr.prNumber)}/comments`,
      "--input",
      "-",
    ];
    const unposted: Finding[] = [];
    let inlinePosted = 0;
    for (const [i, c] of comments.entries()) {
      try {
        await ghApi(
          commentsEndpoint,
          JSON.stringify({ commit_id: pr.headSha, ...commentPayload(c) }),
        );
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

// The job's run summary is the review's long-lived twin: a sticky is overwritten as rounds iterate,
// while each run's summary keeps the review as it stood for that run (issue #205). Best-effort — the
// record must never fail the round — and append, so it joins whatever else the job wrote. The path is
// a parameter rather than an environment read, so the effect is the only thing here that is not pure.
const appendRunSummary = (summaryPath: string | undefined, body: () => string): void => {
  if (summaryPath === undefined || summaryPath === "") return;
  // Rendered OUTSIDE the catch: a failing template is a defect that should surface, and the sticky
  // rendered from the same input a moment earlier, so this throwing means something is genuinely
  // wrong. Only the write is best-effort — a record that cannot be written must not fail the round.
  const rendered = body();
  try {
    appendFileSync(summaryPath, `\n${rendered}\n`);
  } catch (err) {
    process.stderr.write(`Warning: could not write the run summary: ${errMsg(err)}\n`);
  }
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
        // GitHub caps a dismissal message at 140 chars.
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

export const post = async (
  input: PostInput,
  ghApi: GhApi = runGhApi,
  readArtifact: ArtifactReader = ghArtifactReader,
): Promise<void> => {
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

  const [diff, existingSticky] = await Promise.all([
    fetchDiff(input.repo, prNumber, ghApi),
    findBotComment(input.repo, prNumber, input.botLogin, DEFAULT_MARKER, ghApi),
  ]);

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
  // placeholder via carryForwardMarkers). A completed FULL review appends this round below; a CI-fix
  // mechanic pass and every notice carry it forward unchanged so the trajectory is never lost.
  // The prior round trajectory + the convergence to carry forward, read from the JSON convergence field
  // the pipeline stamps into the blob (issue #174), with a one-time fallback to a pre-feature sticky's
  // legacy rounds + compact signal markers. Carried VERBATIM into a non-round post — recomputing at the
  // current threshold would flip a prior round's `converged` when the operator changes
  // convergence_threshold mid-PR.
  const priorDoc = existingSticky !== null ? parseFindingsMarker(existingSticky.body) : null;
  const priorBody = existingSticky?.body ?? "";
  // The trajectory to append to + the recurrence detectors read (priorTrajectory reads the JSON
  // convergence, else the legacy rounds marker — so a legacy prior with only a rounds marker still
  // carries its codes); and the convergence to carry forward on a non-round post (carriedConvergence).
  const priorTraj = priorTrajectory(priorDoc, priorBody);
  const priorConv = carriedConvergence(priorDoc, priorBody);
  // The completed-round count never regresses: nextRoundNumber takes the max round across the trajectory
  // and the carried convergence (a legacy sticky whose compact signal ran ahead of a filtered rounds
  // marker still advances, issue #141), and announce labels its in-progress line with the SAME derivation
  // so the placeholder's round and this round's stamp can't disagree (issue #188 review).
  const priorRoundCount = nextRoundNumber(priorTraj, priorConv?.rounds ?? []) - 1;

  // The agent's document carries no convergence of its own (issue #217 review r7): the pipeline stamps
  // it, and the compact marker beside the findings link carries the SAME stamped object, so a reader of
  // the comment never needs the artifact for the stop signal. A notice / CI-fix pass carries the prior
  // convergence forward, so the trajectory + last score survive a non-round post; a first-run notice
  // with no completed round carries none. convergence is pipeline-owned and ALWAYS overwritten: any
  // value the agent echoed is replaced by the pipeline's (or by undefined, which serializes to an
  // omitted key), so a draft can never smuggle a self-declared score/converged into the document.
  const stampConvergence = (doc: Findings, conv: Convergence | null): Findings => ({
    ...doc,
    convergence: conv ?? undefined,
  });
  // The error rides HERE rather than at the main path's call site, so the notice and lost-envelope
  // paths — which also post a body built from this — say it too. Once per post, not once per surface.
  // When no --json-url can name an artifact and the existing sticky carries a findings marker, the
  // rendered body carries the PRIOR review's findings LINK forward — through findingsBlob, so EVERY
  // rendered body (main, final patch, the empty-diff/corrupt/lost-envelope paths) carries it, and
  // the template places it after the sticky's leading markers so findBotComment still identifies
  // the comment. The freeze guard above still wins for a completed full-review sticky
  // (leaveInPlace); every OTHER marker-carrying sticky — placeholder, mechanic, pre-route — gets
  // the carry instead of a markerless overwrite (issue #235 + #236 r1-r3). The embedded form is
  // not carried — its size is unbounded and a 422 would fail the round.
  const carriedFindingsLink =
    !input.jsonUrl && existingSticky !== null ? findingsArtifactUrl(existingSticky.body) : null;
  let warnedNoJsonUrl = false;
  const findingsBlob = (doc: Findings): string => {
    if (input.jsonUrl) return findingsMarkerPair(input.jsonUrl, doc.convergence);
    if (carriedFindingsLink !== null) {
      // The prior link is carried: the machine channel survives, though this run names no NEW
      // artifact — the sticky's findings remain the prior round's.
      return findingsMarkerPair(carriedFindingsLink, doc.convergence);
    }
    if (!warnedNoJsonUrl) {
      warnedNoJsonUrl = true;
      process.stderr.write(
        "::error::no --json-url was supplied and the existing sticky carries no findings marker to carry forward, so this comment names no findings artifact — the review's prose is intact but its machine channel is gone, and the next round cannot seed from it\n",
      );
    }
    return findingsMarkerPair(undefined, doc.convergence);
  };
  // NOTE: leaveInPlace must NEVER read `verbatimReRaised` — it is also called from the empty-diff
  // and corrupt-findings guards, which run BEFORE the const initializes; a read there throws a
  // TDZ ReferenceError and crashes the post (issue #151 review r4 — a real regression in r3). The
  // post-filter call sites log the drops themselves.
  const leaveInPlace = (message?: string): never => {
    process.stderr.write(
      message ??
        "Review did not complete and the sticky already reflects a completed review — leaving it in place\n",
    );
    process.exit(0);
  };

  // The leave paths cannot write a note — the preserved sticky still surfaces each dropped finding
  // and its reply thread — so the one place that names the drops in the run log, shared by every
  // post-filter leave site (issue #151 review r5). The count is the TRUE pre-dedup dropped-finding
  // count, never the deduped entry list (issue #151 review r7).
  const logAnsweredDrops = (): void => {
    if (verbatimReRaised.length > 0) {
      process.stderr.write(
        `${String(droppedCount)} verbatim re-raise(s) of answered findings were treated as answered — the preserved sticky shows each finding and its prior reply\n`,
      );
    }
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
    if (existingComplete) {
      logAnsweredDrops();
      leaveInPlace(EMPTY_MECHANIC_LEAVE_MESSAGE);
    }
    const priorSha = parseReviewedSha(sticky.body);
    const dropNote = answeredDropNote;
    const body = formatMarkdown(
      noticeBody(
        `${DEFAULT_MARKER}\n\n⚠️ **CI-fix pass completed with no findings** for \`${input.headSha.slice(0, 7)}\`${
          input.unverifiedNoLogs === true
            ? ' — **but no failing-job logs were available**, so it had only the diff to work from and "no findings" is not evidence of none'
            : ""
        } — the completed full review of \`${priorSha ? priorSha.slice(0, 7) : "an earlier commit"}\` is preserved below.${dropNote ? `\n\n${dropNote}` : ""}`,
        sticky.body,
      ),
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
  const inlineRequested = input.inline === true;

  const renderNotice = (message: string): string => {
    // The notice carries the prior convergence forward IN its blob so the trajectory + last score
    // survive; render's incomplete gate keeps the badge/trajectory off the human surface, so a carried
    // "converged" is never shown beside a run that produced no verdict (issue #141 review r2).
    const findings = stampConvergence(incompleteFindings(`### ⚠️ ${message}`), priorConv);
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
        sameRootNotes: {},
        roundCount: priorRoundCount,
        convergenceRound: false,
        runUrl: input.runUrl,
        jsonUrl: input.jsonUrl,
        findingsPointer: findingsBlob(findings),
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
  // The "already answered" state (issue #151): the prior inline findings whose threads a human reply
  // answered, fetched live (the threads persist on GitHub; no carried marker needed). A verbatim
  // re-raise of an answered finding — identical title and reasoning, no new evidence by definition —
  // is treated as closed: dropped from this review's findings, counts, inline comments, and round
  // signal, and NAMED in the sticky (never silently). A re-raise with changed evidence is kept and
  // annotated with the prior answer's link. A failed fetch degrades to an empty registry (the review
  // posts unfiltered); the seed already told the agent what not to re-raise.
  const loadedFindings = findingsResult.findings;
  // The answered-thread fetch runs only when a review will actually be filtered — an empty-diff or
  // corrupt-findings post exits above without paying for the paginated history (issue #151 review
  // r3), and a FIRST-EVER review (no bot sticky at all, so no bot threads can exist) provably has
  // an empty registry (issue #151 review r4).
  // ALWAYS fetch on a filterable post: a missing sticky does not prove an empty thread history (a
  // maintainer can delete the sticky while the threads remain; pre-sticky reviews leave threads
  // with no sticky at all), so the round-4 sticky-absence skip — which could silently starve the
  // registry — is inverted and removed (issue #151 review r7). The empty-diff/corrupt-findings
  // early exits above still avoid the fetch entirely.
  const threadComments = await fetchThreadComments(ghApi, input.repo, prNumber);
  const answeredRegistry =
    threadComments === null ? [] : answeredRegistryFrom(threadComments, input.botLogin);
  const answeredFilter = applyAnswered(loadedFindings.findings, answeredRegistry);
  const reRaisedNotes = answeredFilter.reRaisedNotes;
  const verbatimReRaised = answeredFilter.verbatimReRaised;
  const droppedCount = answeredFilter.droppedCount;
  // Everything downstream (counts, rounds, signal, inline, the embedded blob) reads the FILTERED
  // document — a closed verbatim re-raise is gone from the review, not just from the prose.
  // [...spread] restores the codec's mutable array type. A DROPPED re-raise's code is also
  // stripped from any systemic problem's finding_codes — a "ties together" list must not dangle a
  // finding that is no longer in the document. Scoped to the actual drops: a systemic whose codes
  // were never dropped passes through untouched (issue #151 review r1).
  const droppedCodes = new Set(verbatimReRaised.flatMap((e) => (e.code !== "" ? [e.code] : [])));
  // A dropped code is stripped only when NO KEPT finding still carries it — the drop removed one
  // instance of a mechanism, not the mechanism itself (issue #151 review r2).
  const keptCodes = new Set(
    answeredFilter.findings.flatMap((f) => (f.code !== undefined && f.code !== "" ? [f.code] : [])),
  );
  const trulyDropped = new Set([...droppedCodes].filter((c) => !keptCodes.has(c)));
  const systemic =
    trulyDropped.size === 0
      ? (loadedFindings.systemic_problems ?? [])
      : (loadedFindings.systemic_problems ?? []).map((s) => {
          if (s.finding_codes === undefined) return s;
          const codes = s.finding_codes.filter((c) => !trulyDropped.has(c));
          return codes.length === s.finding_codes.length ? s : { ...s, finding_codes: codes };
        });
  const findings: Findings = {
    ...loadedFindings,
    findings: [...answeredFilter.findings],
    ...(systemic.length > 0 ? { systemic_problems: systemic } : {}),
  };
  // Nit visibility floor (issue #164): split the human-visible findings from the below-floor nits.
  // The blob (`findings`) stays COMPLETE — the machine channel and the next-round seed keep every nit,
  // so a hidden nit reads as already adjudicated and is never re-raised as fresh (a policy-suppressed
  // nit has no external anchor the way an answered-drop's live GitHub thread does, so it MUST remain in
  // the blob). Only the HUMAN surfaces filter: no inline comment, no visible stray, a collapsed aside;
  // the severity histogram and the rounds trajectory stay FULL (a nit contributes 0 to the score, and
  // an all-suppressed round must not read as "clean"). Stickiness, one round deep, re-derived from the
  // prior sticky's blob: a nit matching a prior round's below-floor nit (by code, else title) stays
  // hidden even if its score wobbled up — only a promotion to >= minor un-hides it — so a hidden nit
  // never flickers into view. The prior blob is read ONLY from a completed FULL-REVIEW sticky
  // (isFullReviewSticky) — route-aware like the seed chain, since a mechanic pass writes its OWN
  // findings blob and its nits are not this review's prior round; a notice/placeholder carries an empty
  // or prior blob and is handled the same way. Best-effort: an old/missing/oversized/non-review prior
  // yields no keys, so stickiness fails open to visible.
  // Resolved rather than decoded: the prior sticky's marker names the findings artifact (issue #217),
  // so this fetches it — and still reads an embedded blob on a sticky written before that change.
  // Gated on this round HAVING a nit: the keys only ever match a nit, and the resolve is a download
  // plus an unzip subprocess on the critical path before the sticky write. A round with no nits paid
  // that for a set it could not use.
  const roundHasNit = findings.findings.some((f) => f.severity === "nit");
  const priorDocForNits =
    roundHasNit && existingSticky !== null && isFullReviewSticky(existingSticky.body)
      ? await resolvePriorFindings(existingSticky.body, readArtifact)
      : null;
  const priorSuppressedKeys = new Set(
    priorBelowFloorNits(priorDocForNits, input.nitVisibilityFloor).map((n) =>
      answeredNoteKey({ code: n.code, title: n.title }),
    ),
  );
  const isSuppressedNit = (f: Finding): boolean =>
    f.severity === "nit" &&
    (isBelowVisibilityFloor(f, input.nitVisibilityFloor) ||
      priorSuppressedKeys.has(answeredNoteKey(f)));
  const suppressedNits = findings.findings.filter(isSuppressedNit);
  const visibleFindings = findings.findings.filter((f) => !isSuppressedNit(f));
  // The drop note, shared by every surface that renders the filtered findings: the TRUE pre-dedup
  // count (issue #151 review r5), plus — when the drops emptied the round — a line reconciling the
  // draft's verdict with the empty kept counts, so the sticky never reads "changes requested"
  // beside a converged signal without the explanation (issue #151 review r5).
  const answeredDropNote =
    answeredReRaiseNote(verbatimReRaised, droppedCount) +
    (verbatimReRaised.length > 0 && findings.findings.length === 0
      ? "\n> _The stop signal reflects the kept findings — this round carries none._"
      : "");

  const envelope = loadEnvelope(input.envelopePath);
  const testReport = input.testReportPath ? loadTestReport(input.testReportPath) : undefined;
  const clocDiff = input.clocDiffPath ? loadClocDiff(input.clocDiffPath) : undefined;

  // The route the review job stamped, read the same way render does — `input.route` first, then the
  // envelope — so the workflow's --route passthrough and standalone callers both work, and the
  // sticky's route marker, the guard, and the rounds logic can never disagree.
  const effectiveRoute = input.route ?? envelope?.route;

  if (envelope === null) {
    // The envelope carried the incomplete flag; with it lost, derive incompleteness from the verdict
    // (render does the same) so an error-verdict findings doc here still reads as a notice and — via
    // the guard below — can't bury a completed review, which this branch previously skipped.
    const envelopelessIncomplete = isIncompleteFindings(findings);
    if (wouldBuryCompleted(envelopelessIncomplete)) {
      logAnsweredDrops();
      leaveInPlace();
    }
    // The route is passed through as --route, so an empty mechanic with a lost envelope still
    // cannot bury a completed full review (issue #127).
    if (emptyMechanicWouldBury(effectiveRoute, envelopelessIncomplete) && existingSticky !== null)
      await emptyMechanicLeaveOrNote(existingSticky);
    // A lost envelope is not a completed round, so the prior convergence is carried forward in the
    // blob unchanged rather than a new round being built (issue #174).
    const stampedFindings = stampConvergence(findings, priorConv);
    // This branch lists every visible finding, exactly like the inline-off default, so it can exceed
    // GitHub's comment limit the same way — and here a 422 is the difference between a notice and
    // nothing at all.
    const body = formatMarkdown(
      render({
        findings: stampedFindings,
        envelope: null,
        incomplete: envelopelessIncomplete,
        prices: decodedPrices.right,
        pricesProvided: input.pricesProvided,
        template,
        route: effectiveRoute,
        reviewedSha: input.headSha,
        repo: input.headRepo ?? input.repo,
        effort: input.effort,
        sameRootNotes: {},
        // The answered-state honesty rules apply on EVERY surface that renders the filtered
        // findings — the lost-envelope branch lists every VISIBLE finding (no inline review exists to
        // carry them) so the kept re-raises' annotations actually render, and names the drops
        // exactly like the main path (issues #151 review r1 + r2). The nit visibility floor applies
        // here too (issue #164): below-floor nits are hidden from the human list and shown only in the
        // collapsed aside — the floor is a human-visibility policy, not an inline-comment policy, so it
        // must hold on the surface that lists findings without an inline review.
        strays: visibleFindings,
        suppressedNits,
        nitVisibilityFloor: input.nitVisibilityFloor,
        answeredNotes: reRaisedNotes,
        answeredReRaiseNote: answeredDropNote,
        roundCount: priorRoundCount,
        convergenceRound: false,
        testReport,
        clocDiff,
        inlineDisposition: inlineRequested ? { kind: "no-envelope" } : { kind: "disabled" },
        runUrl: input.runUrl,
        unverifiedNoLogs: input.unverifiedNoLogs,
        jsonUrl: input.jsonUrl,
        findingsPointer: findingsBlob(stampedFindings),
        postedAt: input.postedAt,
      }),
    );
    await upsertSticky(input.repo, prNumber, existingSticky, body, ghApi);
    // The body this branch posts, whatever shape it took, also goes to the run summary.
    appendRunSummary(process.env["GITHUB_STEP_SUMMARY"], () => body);
    if (inlineRequested) {
      process.stderr.write(
        "Warning: inline: true was requested, but the result envelope is missing — inline comments cannot be built; the findings are in the sticky and the run summary instead\n",
      );
    }
    process.stderr.write(
      "Result envelope missing or malformed — posted sticky summary without usage/cost data\n",
    );
    process.exit(0);
  }

  // Read once the lost-envelope branch has passed — that branch posts and exits, and an ENOENT here
  // would have taken its notice with it — but still before anything on THIS path is written, so a
  // misconfigured template fails loudly rather than half-way through posting.
  const inlineTemplate = inlineRequested ? readFileSync(input.inlineTemplatePath, "utf-8") : "";

  // A completed review carries real telemetry; adapt (and the workflow's notice wrap) flag a run that
  // produced only a notice. Don't let such a notice bury an existing completed review or post a stray
  // empty inline review over it — leave the real review in place.
  const thisIncomplete = envelope.incomplete === true || isIncompleteFindings(findings);
  if (wouldBuryCompleted(thisIncomplete)) {
    logAnsweredDrops();
    leaveInPlace();
  }

  if (emptyMechanicWouldBury(effectiveRoute, thisIncomplete) && existingSticky !== null)
    await emptyMechanicLeaveOrNote(existingSticky);

  // A convergence round is a COMPLETED FULL review (effectiveRoute read above — `input.route` first,
  // then the envelope — the same way render does). A mechanic pass or any incomplete/failed run
  // carries the trajectory forward unchanged (it is a CI fix or a non-review, not a round). The
  // verdict guard (isReviewVerdict, render's badge uses the same predicate) also gates the append
  // here, so an out-of-contract "error" verdict that somehow carries findings never counts as a
  // round: the trajectory, the badge, and the blob's convergence stay one decision. A same-head CI
  // retry simply appends again — an identical chip reads as "no change", which is accurate; a
  // reviewed-sha-keyed replace is unsafe because a mechanic stamps a new head without adding a
  // round, so the last round need not be its head. The same-root annotation is a property of a
  // REVIEW round — a mechanic pass is a CI-fix pass, not a round, so it carries no notes — and names
  // the most recent prior round (excluding a same-head retry) each of this round's recurring codes
  // appeared in.
  const isRound =
    isConvergenceRound(effectiveRoute, thisIncomplete) && isReviewVerdict(findings.verdict);
  const sameRootNotes = isRound
    ? computeSameRootNotes(priorTraj, findings.findings, input.headSha.slice(0, 12))
    : {};

  // With inline off there is no diff-anchored surface, so the split does not apply: every visible
  // finding is a stray and the sticky carries them all, exactly as it does when the envelope is lost.
  const {
    comments: rawComments,
    strays,
    inDiff,
  } = inlineRequested
    ? buildInlineComments(visibleFindings, diff, {
        inlineTemplate,
        models: envelope.models.map((m) => m.model),
        findings,
        jsonUrl: input.jsonUrl,
        sameRootNotes,
        answeredNotes: reRaisedNotes,
      })
    : { comments: [], strays: visibleFindings, inDiff: [] };
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
  const initialDisposition: InlineDisposition | undefined = !inlineRequested
    ? { kind: "disabled" }
    : comments.length === 0 && strays.length > 0
      ? { kind: "none-in-diff" }
      : undefined;

  const currentCounts = computeSeverityCounts(findings.findings);

  // This round's mechanism-frequency map (findings + the codes systemic problems tie together) and the
  // true completed-round number, which numbers itself after the carried count. buildConvergence appends
  // this round's score + codes + head SHA to the carried trajectory (prior rounds verbatim) when the run
  // completes a full-review round. A mechanic pass, a notice, or an incomplete run is NOT a round: it
  // carries the prior convergence (the last completed round's, verbatim) forward, so the trajectory + last
  // score survive; render's incomplete gate keeps that off the human surface, so a carried "converged" is
  // never shown beside a run that produced no verdict (issue #141 reviews r2 + r4).
  const currentCodes = computeCodeCounts(findings.findings, findings.systemic_problems ?? []);
  const roundNumber = priorRoundCount + 1;
  const convergence = isRound
    ? buildConvergence(
        findings,
        input.convergenceThreshold,
        priorTraj,
        roundNumber,
        currentCodes,
        input.headSha.slice(0, 12),
      )
    : priorConv;
  const stampedFindings = stampConvergence(findings, convergence);
  const currentRoundCount = isRound ? roundNumber : priorRoundCount;

  // Encode the whole-document marker once — the agent's COMPLETE document with the pipeline-stamped
  // convergence inside it (issues #156 + #174), reused across the sticky + review body; each inline
  // comment embeds only its own finding instead.
  const findingsMarker = findingsBlob(stampedFindings);

  const commonRenderInput: Omit<RenderInput, "inlineDisposition" | "reviewUrl"> = {
    findings: stampedFindings,
    envelope,
    incomplete: thisIncomplete,
    prices: decodedPrices.right,
    pricesProvided: input.pricesProvided,
    template,
    route: effectiveRoute,
    reviewedSha: input.headSha,
    repo: input.headRepo ?? input.repo,
    effort: input.effort,
    testReport,
    clocDiff,
    severityCounts: currentCounts,
    sameRootNotes,
    answeredNotes: reRaisedNotes,
    answeredReRaiseNote: answeredDropNote,
    roundCount: currentRoundCount,
    convergenceThreshold: input.convergenceThreshold,
    nitVisibilityFloor: input.nitVisibilityFloor,
    convergenceRound: isRound,
    strays,
    suppressedNits,
    runUrl: input.runUrl,
    unverifiedNoLogs: input.unverifiedNoLogs,
    jsonUrl: input.jsonUrl,
    findingsPointer: findingsMarker,
    postedAt: input.postedAt,
    pricedAt: input.pricedAt,
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
    unanchoredStrays?: readonly Finding[],
  ): string =>
    formatMarkdown(
      render({
        ...commonRenderInput,
        ...(straysOverride ? { strays: straysOverride } : {}),
        ...(unanchoredCount !== undefined ? { unanchoredCount } : {}),
        ...(unanchoredStrays !== undefined && unanchoredStrays.length > 0
          ? { unanchoredStrays }
          : {}),
        inlineDisposition,
        reviewUrl,
      }) + longFilesNote,
    );

  // The body is posted unshed: GitHub rejects one over 65536 chars, and postComment/patchComment let
  // that 422 propagate, so an oversized body fails the job with the announce placeholder still up.
  // Inline off makes that reachable — every finding's prose now renders into this one comment, where
  // the in-diff ones used to be separate posts. Shedding is issue #214; tolerating a failed write
  // after the sticky is up is issue #223. The embedded document is gone from this body (issue #217),
  // which removed the largest fixed cost it had — an oversized round is now a matter of finding prose,
  // not of a ~32KB blob. Each sticky-listed stray's permalink adds a URL line (~55–130 chars) to this
  // budgeted-by-nobody section, so a nit-heavy inline-off round sits closer to the limit (issue #231 r1).
  // A body with no --json-url carries no findings marker, and upserting it would overwrite the last
  // pointer to the prior findings document. The guard refuses only when the pointer is actually
  // load-bearing: a COMPLETED full-review sticky whose markers gather would seed from. The
  // review-complete requirement exempts the announce placeholder, which carries the route and the
  // markers forward but strips review-complete — it must be replaced by an honest notice, not
  // frozen (post.ts's empty-mechanic path handles it). A mechanic/notice sticky is never a seed
  // either. An expired artifact link is not resolvability-checked here — a fetch in the write path
  // is the wrong trade — so an expired link can still freeze a round; the run log's ::error:: names
  // why (issue #233 r2 + r5 + r6).
  if (
    !input.jsonUrl &&
    existingSticky !== null &&
    parseReviewComplete(existingSticky.body) &&
    parseReviewedRoute(existingSticky.body) === "full review" &&
    hasFindingsMarker(existingSticky.body)
  ) {
    leaveInPlace(
      "no --json-url was supplied and the existing sticky still carries the prior findings document's marker (embedded or link) — leaving it in place rather than severing the seed chain\n",
    );
  }

  // Phase 2: writes — sticky first, inline second. The carry is a property of the rendered body
  // (findingsBlob above), so every write site gets it for free.
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
  // The review object is posted whatever `inline` says — it is the trail from the PR to the sticky and
  // to the run. With inline off it is body-only; the dismiss and minimize below run either way, so
  // flipping a repo to inline=false also clears the threads a previous round left on the diff.
  const {
    url: reviewUrl,
    inlinePosted,
    unposted,
  } = await postInlineReview(
    {
      repo: input.repo,
      prNumber,
      headSha: input.headSha,
      stickyUrl: stickyRef?.url,
      runUrl: input.runUrl,
    },
    comments,
    inDiff,
    ghApi,
  );
  process.stderr.write(
    inlineRequested
      ? `Posted a review with ${String(inlinePosted)} inline comment(s) on PR #${String(prNumber)}\n`
      : `Posted a body-only review on PR #${String(prNumber)}; the findings are in the sticky\n`,
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
        renderBody(
          finalDisposition,
          reviewUrl,
          finalStrays,
          unanchoredCount,
          unanchoredCount > 0 ? unposted : undefined,
        ),
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

  // Same findings, same options, same template — the run summary differs from the sticky in one
  // thing: it carries every finding, because it has no diff to anchor any of them to. That set is
  // `visibleFindings`, which the in-diff/stray split partitions and neither half holds: taking it
  // whole keeps the document's severity order, and cannot list a rejected finding twice. The
  // disposition says which document this is, so the headings do not describe the sticky's contents
  // over the summary's.
  appendRunSummary(process.env["GITHUB_STEP_SUMMARY"], () =>
    renderBody(
      { kind: "whole-document", inlineCount: inlinePosted, rejectedCount: unanchoredCount },
      reviewUrl,
      visibleFindings,
      undefined,
      // The rejected-anchor invariant holds on EVERY surface, the run summary included — this
      // document deliberately carries every finding, so the GitHub-rejected ones must keep their
      // path-only links here too (issue #231 r2).
      unanchoredCount > 0 ? unposted : undefined,
    ),
  );
};

export interface AnnounceInput {
  readonly repo: string;
  readonly headSha: string;
  readonly botLogin: string;
  readonly runUrl: string;
  readonly headBranch?: string;
}

// The notice bodies (announce placeholder, did-not-complete, superseded) share one shape: the sticky
// marker, a lead line, and — when a prior sticky exists — its machine-readable markers carried forward
// verbatim, so replacing the summary prose never strips the re-review seed the review job reads back
// (embedded findings + reviewed-sha). Each body builds its own lead; this helper owns the shared tail.
const noticeBody = (lead: string, existingBody: string | undefined): string => {
  const carried = existingBody ? carryForwardMarkers(existingBody) : "";
  return carried ? `${lead}\n\n${carried}` : lead;
};

// Whether a sticky body references THIS run's URL — matched by the run id (shared grammar with
// checkrun's runIdFromUrl) with a non-digit boundary so a successor whose numeric run id has this one
// as a prefix (…/runs/123 vs …/runs/1234) is not mistaken for this run. Falls back to a plain substring
// when the run URL carries no run id.
const bodyRefsRun = (body: string, runUrl: string): boolean => {
  const runId = runIdFromUrl(runUrl);
  return runId === null
    ? body.includes(runUrl)
    : new RegExp(`/actions/runs/${runId}(?!\\d)`).test(body);
};

// The placeholder body: a "review in progress" line linking the run, plus — when the sticky it replaces
// carried a completed review — the prior convergence trajectory with a pending "⏳" cell for the round
// now running (issue #180), so the iterations → convergence progression stays visible while the review
// runs. The commenter job overwrites this with the real summary when the review completes.
const announceBody = (
  headSha: string,
  runUrl: string,
  existingBody: string | undefined,
): string => {
  const priorDoc = existingBody !== undefined ? parseFindingsMarker(existingBody) : null;
  const prior = existingBody !== undefined ? carriedConvergence(priorDoc, existingBody) : null;
  // The running round is the SAME derivation post uses to number its appended round (nextRoundNumber),
  // so the placeholder's label matches what post will stamp — by construction (issue #188 review).
  const progress =
    prior !== null
      ? inProgressConvergence(
          prior,
          nextRoundNumber(priorTrajectory(priorDoc, existingBody ?? ""), prior.rounds ?? []),
        )
      : "";
  return noticeBody(
    `${DEFAULT_MARKER}\n\n🔄 **Code review in progress** for \`${headSha.slice(0, 7)}\` — see the [workflow run](${runUrl}) for progress; this comment is updated with the review when it completes.${progress ? `\n\n${progress}` : ""}`,
    existingBody,
  );
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
): string =>
  noticeBody(
    `${DEFAULT_MARKER}\n\n⚠️ **Code review did not complete** for \`${headSha.slice(0, 7)}\` — the review job failed ([run](${runUrl})). Re-request the review; do not treat this round as spent.`,
    existingBody,
  );

// A review run CANCELLED is not an operational failure — issue #139. Distinct sentence, no action
// needed, and it must NOT read as a crash: no "did not complete", no "Re-request", and it never
// carries the review-complete marker. The wording is deliberately soft about WHY it was cancelled —
// `needs.review.result == 'cancelled'` also fires for a manual cancel, so the sticky must not assert
// "a newer review run started" as fact, and the run it links is this (cancelled) one, not a "latest"
// run it cannot name. The superseding run's own announce (or the commenter) replaces it.
const cancelledBody = (headSha: string, runUrl: string, existingBody: string | undefined): string =>
  noticeBody(
    `${DEFAULT_MARKER}\n\n↩️ **Code review superseded** for \`${headSha.slice(0, 7)}\` — this run was cancelled before completing, typically because a newer review run started on this branch. No action needed. [View the cancelled run](${runUrl}) for the record.`,
    existingBody,
  );

export interface ReportIncompleteInput extends AnnounceInput {
  // Issue #139: this run was CANCELLED by a superseding run on the same branch — post the
  // informational "superseded" sticky instead of the failure notice.
  readonly cancelled?: boolean;
}

// The human-readable half of failure attribution (the check-run is the machine half): a review that
// died leaves NO comment, so a separate always()-job posts this. Shares announce's PR resolution and
// sticky upsert; the guard is stronger — it never buries a completed review OF ANY head, so a failed
// run reporting late (after a superseding run already finished) can't clobber the real review. A
// CANCELLED run (issue #139) posts the superseded notice instead, and the same guards keep it from
// clobbering a newer run's live placeholder.
export const reportIncomplete = async (
  input: ReportIncompleteInput,
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
  // that overwriting is safe. The run id is matched with a non-digit boundary so a successor whose
  // numeric run id has this one as a prefix (123 vs 1234) is not mistaken for this run.
  if (existing !== null && !bodyRefsRun(existing.body, input.runUrl)) {
    process.stderr.write(`Sticky belongs to another run — leaving it in place\n`);
    return;
  }
  // A CANCELLED run with NO placeholder at all (cancelled before its announce, or a manual cancel with
  // nothing ever posted) must not CREATE a lone "superseded" sticky — nothing superseded it. Only a
  // run that announced (or already posted its own notice) replaces its placeholder. A superseding run
  // will post its own review, so a missing sticky is not a gap.
  if (input.cancelled && existing === null) {
    process.stderr.write(`Cancelled review has no sticky to supersede — leaving it absent\n`);
    return;
  }
  await upsertSticky(
    input.repo,
    resolution.prNumber,
    existing,
    input.cancelled
      ? cancelledBody(input.headSha, input.runUrl, existing?.body)
      : incompleteBody(input.headSha, input.runUrl, existing?.body),
    ghApi,
  );
};
