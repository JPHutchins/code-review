// Ordering invariant: all reads, decodes, and rendering complete before the first API write; then
// the sticky, then the inline review. A posting failure propagates and exits non-zero (never partial).

import { readFileSync, appendFileSync } from "node:fs";
import type {
  ContestedView,
  DiscussionLink,
  InlineComment,
  InlineDisposition,
  RenderInput,
} from "./types.js";
import { buildInlineComments } from "./inline.js";
import { isEmptyDiff, indexDiff, partitionFindings } from "./diff.js";
import {
  render,
  isConvergenceRound,
  isReviewVerdict,
  PER_FINDING_LINKS,
  shedNote,
  terminalNotice,
  verdictBadge,
} from "./render.js";
import { formatMarkdown } from "./format.js";
import { warnStalePrices } from "./cost.js";
import {
  buildConvergence,
  carriedAncestryMarkers,
  carriedConvergence,
  carriedDialogueMarker,
  carriedFindingsMarker,
  carriedMarkerPointer,
  carryForwardMarkers,
  isFullReviewAncestry,
  computeIdCounts,
  computeSameRootNotes,
  dialogueMarker,
  lineRange,
  findingsMarkerPair,
  parseDialogueMarker,
  inProgressConvergence,
  nextRoundNumber,
  isBelowVisibilityFloor,
  isFullReviewSticky,
  priorBelowFloorNits,
  parseCompletedAncestor,
  parseFindingsMarker,
  parseReviewComplete,
  parseMechanicAncestor,
  parseReviewedRoute,
  parseReviewedSha,
  priorTrajectory,
  reviewBodyPointer,
  mechanicConvergence,
  escapeCodeBackticks,
  AGENTS_STOP_DIRECTIVE,
  REVIEW_COMPLETE_MARKER,
  SEVERITIES,
  DEFAULT_CONVERGENCE_THRESHOLD,
} from "./surface.js";

// Exported so the size-guard test asserts the SAME bound the write path enforces — a cap change
// must not silently un-test the shed (the PER_FINDING_LINKS convention).
export const STICKY_CHAR_LIMIT = 65_536;
// The reserve the initial shed leaves for the final patch's additions: the disposition line and
// the shed-immune GitHub-rejected strays. The patch itself is re-sized against the same limit.
export const SHED_RESERVE = 4_000;
// The withShedNote append's length ceiling, folded into every sizing target: a caller template
// that drops the note gets it appended AFTER measurement, so the target must leave room for it
// or the append pushes a reserve-0 body past the limit (issue #214 review r4).
// Sized for the note's embedded run URL (the note renders the raw --run-url; 512 covers a
// ~300-char URL): a caller template that drops the note gets it appended after measurement.
export const SHED_NOTE_BUDGET = 512;
import {
  ResultEnvelopeCodec,
  PriceMapCodec,
  TestSummaryCodec,
  incompleteFindings,
  isIncompleteFindings,
  RECOVERABLE_OPTIONAL_FIELDS,
  ID_SHAPE_RE,
  priorIdsFrom,
} from "./schema.js";
import {
  findingIdIn,
  hasRebuttal,
  resolveFindingId,
  resolveSystemicId,
  systemicIdIn,
  withoutIds,
  withSystemicProblems,
} from "./schema.js";
import type { SystemicProblem } from "./schema.js";
import {
  advanceDialogue,
  dialogueAnswers,
  dialogueMetricsTable,
  reMintedNearMisses,
} from "./dialogue.js";
import type { Convergence, Finding, Findings, ResultEnvelope, TestSummary } from "./schema.js";
import { resolve, resolveTolerantFindings, supportedVersions } from "./registry.js";
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
  applyAnsweredSystemic,
  answeredNoteKey,
  answeredReRaiseNote,
  overruledReRaiseNote,
  answeredRegistryFrom,
  answeredSystemicNoteKey,
  answeredSystemicRegistryFrom,
  applyOverruled,
  couldMatch,
} from "./answered.js";
import {
  answersFrom,
  closingResponses,
  isTrustedResponse,
  withRulingsOn,
  type AnswerSources,
  type Response,
} from "./responses.js";
import { RulingCodec } from "./response-grammar.js";
import { asRecord, errMsg, tryParseJson } from "./util.js";

export interface PostInput {
  readonly repo: string;
  // The head repo (owner/name of the fork) threaded by the workflow via HEAD_REPO — a finding
  // permalink targets the reviewed SHA, which the base repo stops resolving for a fork once the
  // pull ref is force-pushed away. The workflow derives it from the caller's event
  // (workflow_run.head_repository.full_name / pull_request.head.repo.full_name); this base-repo
  // fallback serves the event types it cannot derive from.
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
  // The review dialogue's off switch: no answer is read, and the sticky's dialogue state is carried
  // untouched. Omitted ⇒ the dialogue is on.
  readonly withoutDialogue?: boolean;
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

// comments[i] is the rendered comment for inDiff[i] (1:1, same order). Returns the review url
// (undefined when no breadcrumb review object posted — the caller gates the dismiss/minimize on
// `posted`, the POST's success, not the parsed url), the count that actually posted, and the
// findings GitHub rejected (for the caller to surface in the sticky).
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
  readonly posted: boolean;
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
    return { url: parseHtmlUrl(stdout), posted: true, inlinePosted: comments.length, unposted: [] };
  } catch (err) {
    // The reviews endpoint is atomic — one rejected position fails the whole batch — so on rejection
    // post the body only, then re-post each comment individually, collecting the ones GitHub rejects.
    if (comments.length === 0) {
      // No inline comments to salvage: the breadcrumb review-object POST itself failed. The sticky
      // already carries the full review, so this is a DEGRADED-but-complete round — report it and
      // return posted false; the caller gates the dismiss/minimize on `posted` (the POST's success —
      // an unparseable response still means the object exists), so a permanent failure never leaves
      // the PR review-less (issue #223).
      // An Actions annotation (::warning:: in the step output), not a GITHUB_OUTPUT key: the CLI
      // owns the loudness so every workflow copy and every pinned CLI version sees the degradation.
      process.stderr.write(
        `::warning:: the review-object POST on PR #${String(pr.prNumber)} failed (${errMsg(err)}) — the sticky carries the review, but no diff-anchored review object exists this round\n`,
      );
      return { url: undefined, posted: false, inlinePosted: 0, unposted: [] };
    }
    process.stderr.write(
      `Warning: the batched inline review on PR #${String(pr.prNumber)} was rejected (${errMsg(err)}) — posting the review body-only, then each comment individually to keep the ones GitHub accepts (issue #57)\n`,
    );
    let url: string | undefined;
    let posted = false;
    try {
      url = parseHtmlUrl(await ghApi(reviewsEndpoint, reviewBody(false)));
      posted = true;
    } catch (bodyErr) {
      // The body-only retry failed too — the individual comments still re-post, but no breadcrumb
      // review object exists this round; the caller gates the dismiss/minimize on `posted` (the
      // POST's success — an unparseable response still means the object exists) (issue #223).
      process.stderr.write(
        `::warning:: the body-only review retry on PR #${String(pr.prNumber)} failed (${errMsg(bodyErr)}) — individual comments still re-post, but no breadcrumb review object exists this round\n`,
      );
    }
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
    return { url, posted, inlinePosted, unposted };
  }
};

// ONE projection + ONE fetch for every issue-comment consumer: the sticky lookup (findBotComment)
// and the discussion aside read the same rows. post() fetches the history once per round and passes
// the rows to both; announce routes through findBotComment, which fetches on its own. Transport
// errors PROPAGATE — the callers that must not mistake a failed fetch for an absent sticky let the
// rejection through.
// The issue-comments endpoint returns NO in_reply_to_id — the field exists only on pull-request
// REVIEW comments, and GitHub's API exposes no issue-comment
// reply chain at all. The projection therefore carries only the fields the endpoint actually has.
const ISSUE_COMMENTS_JQ =
  '.[] | {id, user: (.user.login // "(deleted)"), user_type: (.user.type // null), author_association: (.author_association // null), created_at, html_url, body: (.body // "")}';

interface IssueCommentRow {
  readonly id: number;
  readonly author: string;
  readonly created: string;
  readonly url: string;
  readonly body: string;
  // Read for the answers alone, never required: a row without them is still a whole comment.
  readonly authorType: string | null;
  readonly association: string | null;
}

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const parseIssueCommentRows = (
  raw: string,
): { readonly rows: readonly IssueCommentRow[]; readonly malformed: number } => {
  let malformed = 0;
  const rows: IssueCommentRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = tryParseJson(trimmed);
    if (!parsed.ok) {
      malformed += 1;
      continue;
    }
    const rec = asRecord(parsed.value);
    const id = rec?.["id"];
    const author = rec?.["user"];
    const created = rec?.["created_at"];
    const url = rec?.["html_url"];
    const body = rec?.["body"];
    if (
      typeof id === "number" &&
      typeof author === "string" &&
      typeof created === "string" &&
      typeof url === "string" &&
      typeof body === "string"
    ) {
      rows.push({
        id,
        author,
        created,
        url,
        body,
        authorType: nullableString(rec?.["user_type"]),
        association: nullableString(rec?.["author_association"]),
      });
    } else {
      // A shape failure IS corruption: the ghost-account case this branch once served is now
      // coalesced to "(deleted)" in the projection, so every remaining drop is a field the
      // endpoint guarantees — and a dropped sticky row would read as "no sticky" and mint a
      // duplicate, the exact failure the fail-loud invariant exists to prevent.
      malformed += 1;
    }
  }
  // The REST order is not a contract — the caps and the walk derive recency from it, so the rows
  // sort explicitly by (created, id), the sibling registry's discipline.
  rows.sort(
    (a, b) => a.created.localeCompare(b.created) || (a.id > b.id ? 1 : a.id < b.id ? -1 : 0),
  );
  return { rows, malformed };
};

// The author is the GitHub account the commit's author email resolves to, never the self-declared git
// name; the time is the author date, which a rebase keeps.
const COMMITS_JQ =
  ".[] | {sha, message: .commit.message, author: (.author.login // null), date: (.commit.author.date // null)}";

// The PR's commits, read for the answers in their messages. A failed fetch reads no commit answers,
// and a row that does not decode is counted — named, never a failed post.
const fetchCommitAnswersSource = async (
  repo: string,
  prNumber: number,
  ghApi: GhApi,
): Promise<AnswerSources["commits"]> => {
  try {
    const raw = await ghApi([
      `repos/${repo}/pulls/${String(prNumber)}/commits?per_page=100`,
      "--paginate",
      "--jq",
      COMMITS_JQ,
    ]);
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const commits = lines.flatMap((line) => {
      const parsed = tryParseJson(line.trim());
      const rec = parsed.ok ? asRecord(parsed.value) : null;
      const sha = rec?.["sha"];
      const message = rec?.["message"];
      return typeof sha === "string" && typeof message === "string"
        ? [
            {
              sha,
              message,
              author: nullableString(rec?.["author"]),
              date: nullableString(rec?.["date"]),
            },
          ]
        : [];
    });
    if (commits.length < lines.length) {
      process.stderr.write(
        `Warning: ${String(lines.length - commits.length)} of the PR's commits did not decode — their answers close nothing\n`,
      );
    }
    return commits;
  } catch (err) {
    process.stderr.write(
      `Warning: could not read the PR's commits (${errMsg(err)}) — no commit answer closes a finding this round\n`,
    );
    return [];
  }
};

const fetchIssueCommentRows = async (
  repo: string,
  prNumber: number,
  ghApi: GhApi,
): Promise<readonly IssueCommentRow[]> => {
  const raw = await ghApi([
    // per_page rides the QUERY string — a `-f` field would flip `gh api` from GET to POST
    // (create-comment) and 422 every sticky lookup.
    `repos/${repo}/issues/${String(prNumber)}/comments?per_page=100`,
    "--paginate",
    "--jq",
    ISSUE_COMMENTS_JQ,
  ]);
  const { rows, malformed } = parseIssueCommentRows(raw);
  // A sticky lookup is a WRITE-GATING decision: a corrupted fetch that silently read as "no sticky"
  // would mint a duplicate sticky while the real one is still live. Fail loudly instead (the
  // pre-parseJsonl code threw on garbage for exactly this reason).
  if (malformed > 0) {
    throw new Error(
      `${String(malformed)} issue-comment row(s) failed to decode — refusing to treat a corrupted history as an absent sticky`,
    );
  }
  return rows;
};

const selectBotComment = (
  rows: readonly IssueCommentRow[],
  botLogin: string,
  marker: string,
): { readonly id: number; readonly body: string } | null => {
  const bot = rows.filter((r) => r.author === botLogin && r.body.startsWith(marker));
  const last = bot[bot.length - 1];
  return last === undefined ? null : { id: last.id, body: last.body };
};

export const findBotComment = async (
  repo: string,
  prNumber: number,
  botLogin: string,
  marker: string,
  ghApi: GhApi,
): Promise<{ readonly id: number; readonly body: string } | null> =>
  selectBotComment(await fetchIssueCommentRows(repo, prNumber, ghApi), botLogin, marker);

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

// The discussion aside's reply chain (issue #246): every issue comment whose reply chain reaches the
// sticky comment, grouped by the backtick-quoted finding ids its body mentions (the same form the
// sticky renders). Pointers only — the implementer reads the replies at the links.
export interface StickyDiscussion {
  readonly byFinding: Readonly<Record<string, readonly DiscussionLink[]>>;
  // Replies naming an id THIS round's report no longer carries but the PRIOR sticky's findings did:
  // a finding that was fixed or re-id'd between rounds. The sticky is overwritten every round
  // (issue #205), so without this bucket the conversation's pointers vanish from the review surface
  // exactly when the finding left the report.
  readonly orphaned: Readonly<Record<string, readonly DiscussionLink[]>>;
  // How many distinct departed ids were mentioned in total — the rendered section shows
  // "(showing N of M)" when the cap trimmed some, so the cut is named, never silent.
  readonly orphanedTotal: number;
  // Finding id → the pre-cap link total, present only when the 6-newest cap trimmed that finding's
  // list — the aside names its cut instead of rendering indistinguishably from a short thread.
  readonly truncated: Readonly<Record<string, number>>;
  // The same per-token pre-cap totals for the orphaned bucket's entries.
  readonly orphanedTruncated: Readonly<Record<string, number>>;
}

const ID_TOKEN_RE = /`([^`\n]+)`/g;
const ORPHAN_TOKEN_CAP = 8;

// The raw id → escaped DISPLAY spelling index: the sticky renders ids through escapeCodeBackticks
// (backticks → '-', newlines → ' '), so a reply quoting the DISPLAYED spelling of an id must land
// in the same bucket as a reply quoting the raw one. The escaping is not injective (escape-twin ids
// display identically), and an ambiguous spelling must NOT be silently assigned a winner — the
// token stays unmatched and the raw spellings remain the only keys.
const escapedIdIndex = (ids: readonly string[]): ReadonlyMap<string, string> => {
  const owners = new Map<string, string[]>();
  for (const id of ids) {
    const escaped = escapeCodeBackticks(id);
    if (escaped === id) continue;
    const list = owners.get(escaped);
    if (list === undefined) owners.set(escaped, [id]);
    // Deduped: ONE distinct raw id owns its spelling regardless of how many times it appears in
    // the input (a current id also carried by the prior doc); only DISTINCT escape-twins drop it.
    else if (!list.includes(id)) list.push(id);
  }
  return new Map(
    [...owners.entries()].flatMap(([escaped, raws]) =>
      raws.length === 1 && raws[0] !== undefined ? ([[escaped, raws[0]]] as const) : [],
    ),
  );
};

// The discussion rows: EVERY comment on the PR, the sticky's own excluded. GitHub's API exposes
// no reply-chain for issue comments (in_reply_to_id exists only on pull-request REVIEW comments),
// so "replies to the sticky" cannot be derived from any
// channel; the aside groups the whole comment conversation instead, which serves the same
// discoverability. Rows are deduped by id, first occurrence wins — gh --paginate fetches pages
// sequentially, and a comment edited mid-pagination can legitimately appear on two pages; two
// rows for one comment must not push two links into one aside. Computed ONCE per round and shared
// by the gate and the grouping.
export const discussionRows = (
  rows: readonly IssueCommentRow[],
  stickyId: number,
  botLogin: string,
): readonly IssueCommentRow[] => {
  const seen = new Set<number>();
  return rows.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    // Bot-authored comments are the pipeline's own surfaces — a stale or duplicate sticky
    // quotes every finding id and must never scrape into the asides as human discussion.
    return c.id !== stickyId && c.author !== botLogin;
  });
};

// Whether any non-sticky comment names a backtick token this round does NOT report —
// the only case the orphan bucket can be non-empty, and therefore the only case the prior sticky's
// findings document is worth resolving for it. A necessary-not-sufficient condition: a reply
// quoting a code snippet or path in backticks fires it too, and the round pays the artifact
// download for a token that was never a finding id — the local alternative (the sticky's carried
// rounds marker) records ids top-N-capped, so pre-filtering on it would skip real departed ids.
// On the notice path (an empty known set) the same false positive can escalate into the rendered
// unresolvable note when the resolve then fails — an accepted noise cost, since the note names
// the artifact failure itself, never the token as a departed id.
// The id-shape pre-filter: the gate pays the artifact resolve only for an unknown token that
// could plausibly BE a finding id (the pipeline's ids are kebab-case identifiers and the
// synthesized f-/s- base64url forms). A backticked shell command, path, or URL never fires it.
// An id-shaped junk word still fires — the documented necessary-not-sufficient trade-off.

export const mentionsOutsideKnown = (
  reachable: readonly IssueCommentRow[],
  currentIds: readonly string[],
): boolean => {
  const known = new Set(currentIds);
  const escapedToRaw = escapedIdIndex(currentIds);
  for (const c of reachable) {
    for (const m of c.body.matchAll(ID_TOKEN_RE)) {
      const token = m[1];
      if (token === undefined) continue;
      const raw = known.has(token) ? token : escapedToRaw.get(token);
      if ((raw === undefined || !known.has(raw)) && ID_SHAPE_RE.test(token)) return true;
    }
  }
  return false;
};

// The pure comment→discussion grouping: every non-sticky comment on the PR, grouped by the
// backtick-quoted ids it mentions — capped 6 newest-first per id. The orphan bucket holds ONLY
// tokens the PRIOR sticky's findings actually carried (priorIds), never shape-guessed prose: a
// backtick token that was never a finding id is not published as one. Extracted pure so the caps
// and the dedupe are unit-testable without an API mock.
export const buildStickyDiscussion = (
  reachable: readonly IssueCommentRow[],
  currentIds: readonly string[],
  priorIds: readonly string[],
): StickyDiscussion => {
  const known = new Set(currentIds);
  const departed = new Set(priorIds);
  const escapedToRaw = escapedIdIndex([...currentIds, ...priorIds]);
  const byFinding = Object.fromEntries(
    currentIds.map((id): [string, DiscussionLink[]] => [id, []]),
  );
  const orphaned = new Map<string, DiscussionLink[]>();
  const latestAt = new Map<string, string>();
  for (const c of reachable) {
    const link = { author: c.author, when: c.created.slice(0, 10), url: c.url, at: c.created };
    // One link per (comment, token): a reply quoting the same id twice must not crowd the cap.
    const pushed = new Set<string>();
    for (const m of c.body.matchAll(ID_TOKEN_RE)) {
      const token = m[1];
      if (token === undefined || pushed.has(token)) continue;
      pushed.add(token);
      const rawKnown = known.has(token);
      const alias = rawKnown ? undefined : escapedToRaw.get(token);
      const aliasIsKnown = alias !== undefined && known.has(alias);
      const rawDeparted = departed.has(token);
      if (rawKnown) {
        byFinding[token]?.push(link);
      } else if (aliasIsKnown) {
        // A token that is BOTH a current id's display alias and a departed raw id is ambiguous —
        // it stays unmatched rather than silently winning for either side.
        if (!rawDeparted) byFinding[alias]?.push(link);
      } else if (rawDeparted) {
        const key = token;
        const links = orphaned.get(key);
        if (links === undefined) orphaned.set(key, [link]);
        else links.push(link);
        const latest = latestAt.get(key);
        if (latest === undefined || c.created.localeCompare(latest) > 0)
          latestAt.set(key, c.created);
      } else if (alias !== undefined && departed.has(alias)) {
        // The token is a DEPARTED id's display spelling — filed under the departed raw id, the
        // same attribution the orphan bucket's contract promises.
        const key = alias;
        const links = orphaned.get(key);
        if (links === undefined) orphaned.set(key, [link]);
        else links.push(link);
        const latest = latestAt.get(key);
        if (latest === undefined || c.created.localeCompare(latest) > 0)
          latestAt.set(key, c.created);
      }
    }
  }
  // Map-built then Object.fromEntries: a `__proto__`-named id must record its cut like any other
  // key, which a bare {}-literal assignment silently swallows.
  const truncated = new Map<string, number>();
  for (const [id, links] of Object.entries(byFinding)) {
    links.reverse();
    if (links.length > PER_FINDING_LINKS) {
      truncated.set(id, links.length);
      links.splice(PER_FINDING_LINKS);
    }
  }
  const orphanedTruncated = new Map<string, number>();
  for (const [token, links] of orphaned) {
    links.reverse();
    if (links.length > PER_FINDING_LINKS) {
      orphanedTruncated.set(token, links.length);
      links.splice(PER_FINDING_LINKS);
    }
  }
  // Bound the orphan bucket at the 8 NEWEST departed ids (by their latest reply's FULL timestamp —
  // the date-only display string would tie same-day replies and let the stable sort cut the newer
  // one), matching the newest-first discipline the per-finding lists keep.
  const orphanedTotal = orphaned.size;
  const byLatestReply = [...orphaned.entries()].sort((a, b) =>
    (latestAt.get(b[0]) ?? "").localeCompare(latestAt.get(a[0]) ?? ""),
  );
  return {
    byFinding,
    orphaned: Object.fromEntries(byLatestReply.slice(0, ORPHAN_TOKEN_CAP)),
    orphanedTotal,
    truncated: Object.fromEntries(truncated),
    orphanedTruncated: Object.fromEntries(orphanedTruncated),
  };
};

// Best-effort append to a runner file: a write failure warns with the given label and never fails
// the round. The path is a parameter, so the effect is the only thing here that is not pure.
const appendBestEffort = (path: string | undefined, label: string, body: string): void => {
  if (path === undefined || path === "") return;
  try {
    appendFileSync(path, body);
  } catch (err) {
    process.stderr.write(`Warning: could not write ${label}: ${errMsg(err)}\n`);
  }
};

// The posted signal travels through the step's GITHUB_OUTPUT file — the runner publishes it as the
// step's output when the step completes. Written INSIDE upsertSticky so every sticky landing (the
// main path and the notice paths alike) signals itself, and written as posted=false on the
// deliberate no-write exits so a never-landed run never reads as landed.
const writePostedSignal = (value: boolean): void => {
  appendBestEffort(
    process.env["GITHUB_OUTPUT"],
    "the posted signal to GITHUB_OUTPUT",
    `posted=${value ? "true" : "false"}\n`,
  );
};

// The job's run summary is the review's long-lived twin: a sticky is overwritten as rounds iterate,
// while each run's summary keeps the review as it stood for that run (issue #205). The template
// renders OUTSIDE the best-effort write: a failing template is a defect that should surface, and the
// sticky rendered from the same input a moment earlier, so this throwing means something is
// genuinely wrong. Only the write is best-effort.
const appendRunSummary = (summaryPath: string | undefined, body: () => string): void => {
  if (summaryPath === undefined || summaryPath === "") return;
  const rendered = body();
  appendBestEffort(summaryPath, "the run summary", `\n${rendered}\n`);
};

// Trust by author identity (bot login), not the marker alone. Returns null only when a NEW comment's
// response couldn't be parsed — there is then no id to re-patch with the review link.
const upsertSticky = async (
  repo: string,
  prNumber: number,
  existing: { readonly id: number; readonly body: string } | null,
  body: string,
  ghApi: GhApi,
  signal = false,
): Promise<{ readonly id: number; readonly url: string | undefined } | null> => {
  if (existing !== null) {
    const patched = await patchComment(repo, existing.id, body, ghApi);
    process.stderr.write(
      `Updated sticky comment #${String(existing.id)} on PR #${String(prNumber)}\n`,
    );
    if (signal) writePostedSignal(true);
    return { id: existing.id, url: patched?.html_url };
  }
  const posted = await postComment(repo, prNumber, body, ghApi);
  process.stderr.write(`Posted new sticky comment on PR #${String(prNumber)}\n`);
  if (signal && posted !== null) writePostedSignal(true);
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

type PresentRenderKeys<K extends keyof RenderInput> = { readonly [P in K]-?: RenderInput[P] };
type RenderRunKey =
  | "prices"
  | "pricesProvided"
  | "template"
  | "route"
  | "reviewedSha"
  | "effort"
  | "runUrl"
  | "jsonUrl"
  | "postedAt";
type RenderSurfaceKey =
  | "findings"
  | "envelope"
  | "incomplete"
  | "sameRootNotes"
  | "roundCount"
  | "convergenceRound"
  | "strays"
  | "findingsPointer";
type RenderCallKey =
  | "shedCount"
  | "terminal"
  | "unanchoredStrays"
  | "unanchoredCount"
  | "inlineDisposition"
  | "reviewUrl";
type RenderDerivedKey = "severityCounts" | "rounds";
type SharedRenderKey = Exclude<
  keyof RenderInput,
  RenderSurfaceKey | RenderCallKey | RenderDerivedKey
>;

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
    writePostedSignal(false);
    process.exit(0);
  }
  if (resolution.kind === "not-open") {
    process.stderr.write(
      `PR #${String(resolution.prNumber)} for ${input.headSha} is not open (state: ${resolution.state}) — nothing to post\n`,
    );
    writePostedSignal(false);
    process.exit(0);
  }
  const prNumber = resolution.prNumber;

  const [diff, commentRows] = await Promise.all([
    fetchDiff(input.repo, prNumber, ghApi),
    fetchIssueCommentRows(input.repo, prNumber, ghApi),
  ]);
  const existingSticky = selectBotComment(commentRows, input.botLogin, DEFAULT_MARKER);

  // An incomplete result (a notice, not a completed review) must never overwrite a sticky that
  // already shows a completed review — else a superseded/killed/late run buries a real review under a
  // "did not complete" that reads as a clean pass. A completed result always writes; an in-progress
  // placeholder is not "complete" (it lacks the marker), so its own commenter may still write.
  const existingComplete = existingSticky !== null && parseReviewComplete(existingSticky.body);
  const wouldBuryCompleted = (incomplete: boolean): boolean => incomplete && existingComplete;

  // "The sticky reflects a completed FULL review": the isFullReviewSticky predicate (route marker
  // wins, round history as the pre-marker fallback), plus, for a sticky with no route or round
  // signal at all, the two completed-review signals of the pre-marker era — review-complete on the
  // sticky itself, or the carried completed-ancestor marker (a notice carries that ANCESTRY marker,
  // never review-complete itself). This deliberately does NOT require review-complete: the announce
  // placeholder strips it while preserving the route and round markers, and an empty mechanic must
  // not bury the full review the placeholder still records.
  const priorIsFullReview = (body: string): boolean =>
    isFullReviewSticky(body) ||
    (parseReviewedRoute(body) === null &&
      (parseReviewComplete(body) ||
        (parseCompletedAncestor(body) && !parseMechanicAncestor(body))));

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
  // the carry instead of a markerless overwrite (issue #235 + #236 r1-r3). Only the LINK form is
  // carried here — re-embedding the base64 form would put an unbounded blob back into the body
  // that is posted unshed against GitHub's 65536 limit, the 422 class the link form exists to
  // prevent. (The notice paths DO re-emit a carried embedded marker verbatim: their bodies are
  // short, and the pre-#217 blob was size-gated when written.)
  let warnedNoJsonUrl = false;
  const findingsPair = (doc: Findings): string => {
    if (input.jsonUrl) return findingsMarkerPair(input.jsonUrl, doc.convergence);
    const carriedLink = existingSticky !== null ? findingsArtifactUrl(existingSticky.body) : null;
    if (carriedLink !== null) {
      // The prior link is carried: the machine channel survives, though this run names no NEW
      // artifact — the sticky's findings remain the prior round's.
      return findingsMarkerPair(carriedLink, doc.convergence);
    }
    if (!warnedNoJsonUrl) {
      warnedNoJsonUrl = true;
      process.stderr.write(
        "::error::no --json-url was supplied and the existing sticky carries no findings marker to carry forward, so this comment names no findings artifact — the review's prose is intact but its machine channel is gone, and the next round cannot seed from it\n",
      );
    }
    return findingsMarkerPair(undefined, doc.convergence);
  };
  const carriedDialogue = existingSticky !== null ? carriedDialogueMarker(existingSticky.body) : "";
  const findingsBlob = (doc: Findings, dialogue: string = carriedDialogue): string =>
    [findingsPair(doc), dialogue].filter((marker) => marker !== "").join("\n");
  // NOTE: leaveInPlace must NEVER read `verbatimReRaised` — it is also called from the empty-diff
  // and corrupt-findings guards, which run BEFORE the const initializes; a read there throws a
  // TDZ ReferenceError and crashes the post (issue #151 review r4 — a real regression in r3). The
  // post-filter call sites log the drops themselves.
  const leaveInPlace = (message?: string): never => {
    process.stderr.write(
      message ??
        "Review did not complete and the sticky already reflects a completed review — leaving it in place\n",
    );
    // The preserved sticky IS the landed review — signal it, so a deliberate leave never reads as
    // never-posted and never rides the exit-0 fallback.
    writePostedSignal(true);
    process.exit(0);
  };

  // The leave paths cannot write a note — the preserved sticky still surfaces each dropped finding
  // — so the one place that names the drops in the run log, shared by every
  // post-filter leave site (issue #151 review r5). The count is the TRUE pre-dedup dropped-finding
  // count, never the deduped entry list (issue #151 review r7).
  const logAnsweredDrops = (): void => {
    if (droppedCount > 0) {
      process.stderr.write(
        `${String(droppedCount)} verbatim re-raise(s) of answered findings or systemic problems were treated as answered — the preserved sticky shows each one\n`,
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
            ? ' — **but no failing-job logs were available**, so it worked from the diff and any local reproduction of the checks, and "no findings" is not evidence of none'
            : ""
        } — the completed full review of \`${priorSha ? priorSha.slice(0, 7) : "an earlier commit"}\` is preserved below.${dropNote ? `\n\n${dropNote}` : ""}`,
        sticky.body,
      ),
    );
    await upsertSticky(input.repo, prNumber, sticky, body, ghApi, true);
    process.exit(0);
  };

  const prices = JSON.parse(readFileSync(input.pricesPath, "utf-8")) as unknown;
  const decodedPrices = PriceMapCodec.decode(prices);
  if (decodedPrices._tag === "Left") {
    throw new Error(`Price map at ${input.pricesPath} does not match the expected shape`);
  }
  // Once per round, before any render — the sticky's cost collapsible carries the snapshot date,
  // and a map predating this CLI's release warns as a step annotation (issue #220). Null when the
  // consumer configured no pricing: a bundled example map they never supplied is never stale.
  warnStalePrices(input.pricesProvided ? decodedPrices.right : null);
  const template = readFileSync(input.templatePath, "utf-8");
  const inlineRequested = input.inline === true;
  // Loaded before the notice paths: their convergence stamps read the route, exactly like the main
  // path (issue #224's mechanic pin must hold on EVERY write path).
  const envelope = loadEnvelope(input.envelopePath);
  // The route the review job stamped, read the same way render does — `input.route` first, then the
  // envelope — so the workflow's --route passthrough and standalone callers both work, and the
  // sticky's route marker, the guard, and the rounds logic can never disagree.
  const effectiveRoute = input.route ?? envelope?.route;
  const runRenderInput: PresentRenderKeys<RenderRunKey> = {
    prices: decodedPrices.right,
    pricesProvided: input.pricesProvided,
    template,
    route: effectiveRoute,
    reviewedSha: input.headSha,
    effort: input.effort,
    runUrl: input.runUrl,
    jsonUrl: input.jsonUrl,
    postedAt: input.postedAt,
  };

  const reachable =
    existingSticky !== null ? discussionRows(commentRows, existingSticky.id, input.botLogin) : [];
  // The discussion orphan gate excludes ONLY a mechanic prior: its own findings are not this
  // review's departed findings. Every other prior feeds the bucket — a full review, a pre-rounds
  // sticky (no route marker, but its embedded blob still resolves), and a placeholder (whose
  // carried link resolves the last full review's document).
  const priorIsMechanic =
    existingSticky !== null &&
    (parseReviewedRoute(existingSticky.body) === "mechanic" ||
      parseMechanicAncestor(existingSticky.body));

  // The notice overwrites the sticky with no findings of its own — the pointer trail a replied-to
  // prior sticky carries must survive the overwrite. Resolved and grouped ONLY when a notice
  // actually exits (the rare path); a normal round never pays this. The prior document's ids are
  // the whole departed set for a notice (the notice reports nothing), and only a full-review prior
  // may feed it — a mechanic pass's own findings are not this review's departed findings.
  const noticeDiscussion = async (): Promise<{
    readonly orphanedDiscussion: Readonly<Record<string, readonly DiscussionLink[]>>;
    readonly orphanedTotal: number;
    readonly orphanedTruncated: Readonly<Record<string, number>>;
    readonly orphanedUnresolvable: boolean;
  }> => {
    if (existingSticky === null) {
      return {
        orphanedDiscussion: {},
        orphanedTotal: 0,
        orphanedTruncated: {},
        orphanedUnresolvable: false,
      };
    }
    const wantsPrior = !priorIsMechanic && mentionsOutsideKnown(reachable, []);
    const resolved = wantsPrior
      ? await resolvePriorFindings(existingSticky.body, readArtifact)
      : null;
    const built = buildStickyDiscussion(reachable, [], priorIdsFrom(resolved));
    // "Unresolvable" claims an artifact failed — it must never fire for a marker-less prior
    // (a first-run placeholder), where there is no artifact to fail.
    const hadMarker = carriedFindingsMarker(existingSticky.body) !== null;
    return {
      orphanedDiscussion: built.orphaned,
      orphanedTotal: built.orphanedTotal,
      orphanedTruncated: built.orphanedTruncated,
      orphanedUnresolvable: wantsPrior && hadMarker && resolved === null,
    };
  };

  const renderNotice = (
    message: string,
    discussion: Awaited<ReturnType<typeof noticeDiscussion>>,
  ): string => {
    // The notice carries the prior convergence forward IN its blob so the trajectory + last score
    // survive; render's incomplete gate keeps the badge/trajectory off the human surface, so a carried
    // "converged" is never shown beside a run that produced no verdict (issue #141 review r2). A
    // MECHANIC notice stamps the never-converged pin instead — CI failed, whatever the prior said
    // (issue #224: the pin holds on every write path, not just the main one).
    const noticeConvergence =
      effectiveRoute === "mechanic"
        ? mechanicConvergence(
            priorConv,
            input.convergenceThreshold ?? DEFAULT_CONVERGENCE_THRESHOLD,
          )
        : priorConv;
    const findings = stampConvergence(incompleteFindings(`### ⚠️ ${message}`), noticeConvergence);
    // The notice's own blob holds no findings — stamping its link would point the NEXT round's
    // resolve at an empty document and sever the departed set the trail needs. The prior sticky's
    // findings marker is carried verbatim instead — BOTH forms via the shared extractor, never a
    // hand-rolled link-only carry — with the notice's own convergence stamp beside it.
    const noticeFindingsPointer = (doc: Findings): string => {
      const carried = existingSticky !== null ? carriedFindingsMarker(existingSticky.body) : null;
      if (carried === null) return findingsBlob(doc);
      // The prior's provenance rides beside its findings marker: a mechanic-origin prior must stay
      // mechanic through the notice, or the next round's orphan gate reads its findings as a
      // departed full review's.
      const provenance = existingSticky !== null ? carriedAncestryMarkers(existingSticky.body) : "";
      return [carriedMarkerPointer(carried, doc.convergence), carriedDialogue, provenance]
        .filter((p) => p !== "")
        .join("\n\n");
    };
    return formatMarkdown(
      render({
        ...runRenderInput,
        findings,
        envelope: null,
        incomplete: true,
        sameRootNotes: {},
        roundCount: priorRoundCount,
        convergenceRound: false,
        findingsPointer: noticeFindingsPointer(findings),
        orphanedDiscussion: discussion.orphanedDiscussion,
        orphanedTotal: discussion.orphanedTotal,
        orphanedTruncated: discussion.orphanedTruncated,
        orphanedUnresolvable: discussion.orphanedUnresolvable,
      }),
    );
  };

  if (isEmptyDiff(diff)) {
    if (wouldBuryCompleted(true)) leaveInPlace();
    const discussion = await noticeDiscussion();
    await upsertSticky(
      input.repo,
      prNumber,
      existingSticky,
      renderNotice("The diff for this PR is empty — nothing to review.", discussion),
      ghApi,
      true,
    );
    process.exit(0);
  }

  const findingsResult = loadFindings(input.findingsPath);
  if (findingsResult.kind !== "ok") {
    if (wouldBuryCompleted(true)) leaveInPlace();
    const discussion = await noticeDiscussion();
    await upsertSticky(
      input.repo,
      prNumber,
      existingSticky,
      renderNotice(noticeMessageFor(findingsResult), discussion),
      ghApi,
      true,
    );
    process.exit(0);
  }
  // The "already answered" state (issue #151): the prior findings a maintainer's answer refuted or
  // dismissed. A verbatim re-raise of one — identical claim, no rebuttal, no new evidence by
  // definition — is treated as closed: dropped from this review's findings, counts, inline comments,
  // and round signal, and NAMED in the sticky (never silently). A re-raise with changed evidence is
  // kept and annotated with the answer's link. The answers are read HERE, through this step's own
  // token, from every comment and commit on the PR: the sticky names their authors, so they never
  // come from a file the reviewing agent could have written. Only a full-review prior has findings an
  // answer can name, or dialogue state an answer can advance.
  const loadedFindings = findingsResult.findings;
  const priorDialogue =
    existingSticky !== null && input.withoutDialogue !== true
      ? parseDialogueMarker(existingSticky.body)
      : { entries: [], undecoded: [], skipped: 0 };
  if (priorDialogue.skipped > 0) {
    process.stderr.write(
      `Warning: ${String(priorDialogue.skipped)} entry(ies) of the prior sticky's dialogue state did not decode — carried unread\n`,
    );
  }
  // The dialogue advances only on a completed full-review round; any other post carries it as is.
  const dialogueRound =
    input.withoutDialogue !== true &&
    envelope !== null &&
    isConvergenceRound(
      effectiveRoute,
      envelope.incomplete === true || isIncompleteFindings(loadedFindings),
    ) &&
    isReviewVerdict(loadedFindings.verdict);
  const answerable =
    input.withoutDialogue !== true &&
    existingSticky !== null &&
    !priorIsMechanic &&
    (loadedFindings.findings.length > 0 ||
      (loadedFindings.systemic_problems ?? []).length > 0 ||
      (dialogueRound && priorDialogue.entries.length > 0));
  // A commit answer's trust is the push access a head branch IN the base repo implies, read from the
  // PR itself: a fork's head, or a deleted fork's null one, trusts no commit, and its commits go unread.
  const headInBaseRepo =
    answerable &&
    resolution.headRepo !== null &&
    resolution.headRepo.toLowerCase() === input.repo.toLowerCase();
  const answers = answerable
    ? answersFrom({
        repo: input.repo,
        prNumber,
        botLogin: input.botLogin,
        comments: commentRows.map((row) => ({
          id: row.id,
          body: row.body,
          user: { login: row.author, type: row.authorType },
          created_at: row.created,
          author_association: row.association,
        })),
        commits: headInBaseRepo ? await fetchCommitAnswersSource(input.repo, prNumber, ghApi) : [],
      })
    : { comments: [], commits: [] };
  const isTrusted = (response: Response): boolean => isTrustedResponse(response, headInBaseRepo);
  const allAnswers = withRulingsOn(
    [...answers.comments, ...answers.commits],
    new Set(
      priorDialogue.entries.filter((entry) => entry.state !== "rebutted").map((entry) => entry.id),
    ),
    isTrusted,
  );
  const unorderedRulings = allAnswers.filter(
    (answer) =>
      RulingCodec.is(answer.disposition) && Number.isNaN(Date.parse(answer.created_at ?? "")),
  ).length;
  if (unorderedRulings > 0) {
    process.stderr.write(
      `Warning: ${String(unorderedRulings)} maintainer ruling(s) carry no readable time, so they cannot be ordered against the other answers — not applied\n`,
    );
  }
  const allClosures = closingResponses(allAnswers, isTrusted);
  const dialogue =
    answerable && dialogueRound
      ? advanceDialogue(priorDialogue.entries, dialogueAnswers(allAnswers, isTrusted), [
          ...loadedFindings.findings.map((f) => ({
            id: resolveFindingId(f),
            title: f.title,
            severity: f.severity,
            rebutted: hasRebuttal(f),
          })),
          ...(loadedFindings.systemic_problems ?? []).flatMap((s) => {
            const id = resolveSystemicId(s);
            return id === undefined
              ? []
              : [{ id, title: s.title, severity: s.severity, rebutted: hasRebuttal(s) }];
          }),
        ])
      : priorDialogue.entries;
  // An upheld id stays open whatever older answer would close it. Only a closure some current finding
  // or systemic problem could match is worth the prior's download.
  const upheldIds = new Set(
    dialogue.filter((entry) => entry.state === "upheld").map((entry) => entry.id),
  );
  const closures = allClosures.filter(
    (closure) => couldMatch(closure.id, loadedFindings) && !upheldIds.has(closure.id),
  );
  const contested = dialogueRound ? dialogue.filter((entry) => entry.state === "contested") : [];
  const contestedIds = new Set(contested.map((entry) => entry.id));
  const isContestedFinding = findingIdIn(contestedIds);
  const isContestedSystemic = systemicIdIn(contestedIds);
  // The prior document the closures name, resolved only when one exists — and the one resolve the
  // nit stickiness and the discussion gate below reuse.
  const priorForAnswers =
    closures.length > 0 && existingSticky !== null
      ? { value: await resolvePriorFindings(existingSticky.body, readArtifact) }
      : null;
  const answeredPrior =
    priorForAnswers === null ? null : resolveTolerantFindings(priorForAnswers.value);
  if (priorForAnswers !== null && answeredPrior === null) {
    process.stderr.write(
      `Warning: ${String(closures.length)} maintainer answer(s) close prior findings, but the prior review's findings did not resolve — no re-raise is treated as answered\n`,
    );
  }
  const answeredRegistry = answeredRegistryFrom(closures, answeredPrior);
  const answeredSystemicRegistry = answeredSystemicRegistryFrom(closures, answeredPrior);
  const boundIds = new Set([...answeredRegistry, ...answeredSystemicRegistry].map((e) => e.code));
  const unboundClosureCount =
    answeredPrior === null ? 0 : closures.filter((closure) => !boundIds.has(closure.id)).length;
  if (unboundClosureCount > 0) {
    process.stderr.write(
      `Warning: ${String(unboundClosureCount)} maintainer answer(s) name nothing the prior review reported — they close nothing this round\n`,
    );
  }
  // A contested item is argued under its own section, so no answer drops or annotates it. An
  // overruled id's ruling closes it before any answer is weighed.
  const rulings = new Map(
    dialogue
      .filter((entry) => entry.state === "overruled")
      .map((entry) => [
        entry.id,
        {
          code: entry.id,
          title: entry.title,
          answerUrl: entry.answer,
          answerAuthor:
            allAnswers.find((answer) => answer.source_url === entry.answer)?.author ?? null,
        },
      ]),
  );
  const overruledFilter = applyOverruled(
    loadedFindings.findings.filter((f) => !isContestedFinding(f)),
    rulings,
    resolveFindingId,
    answeredNoteKey,
  );
  const overruledSystemicFilter = applyOverruled(
    (loadedFindings.systemic_problems ?? []).filter((s) => !isContestedSystemic(s)),
    rulings,
    resolveSystemicId,
    answeredSystemicNoteKey,
  );
  const answeredFilter = applyAnswered(overruledFilter.kept, answeredRegistry);
  const answeredSystemicFilter = applyAnsweredSystemic(
    overruledSystemicFilter.kept,
    answeredSystemicRegistry,
  );
  const contestedFindings = loadedFindings.findings.filter(isContestedFinding);
  const contestedSystemic = (loadedFindings.systemic_problems ?? []).filter(isContestedSystemic);
  const contestedReRaises = new Map<string, Finding | SystemicProblem>([
    ...contestedSystemic.map((s) => [resolveSystemicId(s) ?? "", s] as const),
    ...contestedFindings.map((f) => [resolveFindingId(f), f] as const),
  ]);
  const contestedViews: readonly ContestedView[] = contested.map((entry) => {
    const reRaise = contestedReRaises.get(entry.id);
    return {
      id: entry.id,
      title: entry.title,
      severity: entry.severity,
      answerUrl: entry.answer,
      ...(reRaise === undefined
        ? {}
        : {
            reRaise: {
              ...("path" in reRaise
                ? {
                    location: `${reRaise.path}:${lineRange(reRaise.start_line, reRaise.end_line, "–")}`,
                  }
                : {}),
              description: reRaise.description,
              reasoning: reRaise.reasoning,
              ...(hasRebuttal(reRaise) ? { rebuttal: reRaise.rebuttal ?? "" } : {}),
            },
          }),
    };
  });
  const reRaisedNotes = {
    ...answeredFilter.reRaisedNotes,
    ...answeredSystemicFilter.reRaisedNotes,
    ...overruledFilter.reRaisedNotes,
    ...overruledSystemicFilter.reRaisedNotes,
  };
  const verbatimReRaised = answeredFilter.verbatimReRaised;
  const droppedCount =
    answeredFilter.droppedCount +
    answeredSystemicFilter.droppedCount +
    overruledFilter.droppedCount +
    overruledSystemicFilter.droppedCount;
  // Everything downstream (counts, rounds, signal, inline, the embedded blob) reads the FILTERED
  // document — a closed verbatim re-raise is gone from the review, not just from the prose.
  // [...spread] restores the codec's mutable array type. A DROPPED re-raise's code is also
  // stripped from any systemic problem's finding_ids — a "ties together" list must not dangle a
  // finding that is no longer in the document. Scoped to the actual drops: a systemic whose codes
  // were never dropped passes through untouched (issue #151 review r1).
  // Both the dropped entries' codes AND the dropped FINDINGS' resolved ids: a title-matched drop of
  // a fresh-id finding keys the entry's synthesized code, but the systemic list names the finding's
  // own id — stripping by entry code alone would dangle it.
  const droppedIds = new Set([
    ...[...verbatimReRaised, ...overruledFilter.verbatimReRaised].flatMap((e) =>
      e.code !== "" ? [e.code] : [],
    ),
    ...answeredFilter.droppedFindingIds.filter((id) => id !== ""),
  ]);
  // A dropped code is stripped only when NO KEPT finding still carries it — the drop removed one
  // instance of a mechanism, not the mechanism itself (issue #151 review r2).
  const keptCodes = new Set([...answeredFilter.findings, ...contestedFindings].map((f) => f.id));
  const trulyDropped = new Set([...droppedIds].filter((c) => !keptCodes.has(c)));
  const systemic =
    trulyDropped.size === 0
      ? answeredSystemicFilter.systemic
      : answeredSystemicFilter.systemic.map((s) => {
          if (s.finding_ids === undefined) return s;
          const codes = s.finding_ids.filter((c) => !trulyDropped.has(c));
          return codes.length === s.finding_ids.length ? s : { ...s, finding_ids: codes };
        });
  const findings: Findings = {
    ...withSystemicProblems(loadedFindings, [...systemic, ...contestedSystemic]),
    findings: [...answeredFilter.findings, ...contestedFindings],
  };
  // Nit visibility floor (issue #164): split the human-visible findings from the below-floor nits.
  // The blob (`findings`) stays COMPLETE — the machine channel and the next-round seed keep every nit,
  // so a hidden nit reads as already adjudicated and is never re-raised as fresh (a policy-suppressed
  // nit has no external anchor the way an answered drop's closing answer does, so it MUST remain in
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
  // One resolve serves every consumer — the answered registry above, the nit stickiness keys, and the
  // discussion orphan gate — and the resolve is a download plus an unzip subprocess on the critical
  // path before the sticky write, so it is paid only when one of them can use it. The nit keys only ever match a nit; the
  // orphan bucket is non-empty only when a reply names an id-shaped token this round does not
  // report (with no prior ids the bucket is empty either way, so that gate skips a fetch it could
  // not use, never an output it could change).
  // The PROVISIONAL known set (every finding id + the systemics) gates the fetch BEFORE the nit
  // split: the split's stickiness reads the prior document, so the exact set cannot be computed
  // until the resolve has happened. The provisional set is a superset of the exact one, so a round
  // pays the fetch a second time below ONLY for the tokens the split narrows out — the ids of
  // inline-posted findings.
  const broadCurrentIds = [
    ...findings.findings.map((f) => f.id).filter((id) => id !== ""),
    ...(findings.systemic_problems ?? [])
      .map((s) => s.id)
      .filter((id): id is string => id !== undefined && id !== ""),
  ];
  const argued = findings.findings.filter((f) => !isContestedFinding(f));
  const roundHasNit = argued.some((f) => f.severity === "nit");
  const nitWantsPrior =
    roundHasNit &&
    existingSticky !== null &&
    (isFullReviewSticky(existingSticky.body) || isFullReviewAncestry(existingSticky.body));
  const broadWantsPrior =
    existingSticky !== null && !priorIsMechanic && mentionsOutsideKnown(reachable, broadCurrentIds);
  const resolvedPrior =
    priorForAnswers !== null
      ? priorForAnswers.value
      : existingSticky !== null && (nitWantsPrior || broadWantsPrior)
        ? await resolvePriorFindings(existingSticky.body, readArtifact)
        : null;
  const priorDocForNits = nitWantsPrior ? resolvedPrior : null;
  const priorSuppressedKeys = new Set(
    priorBelowFloorNits(priorDocForNits, input.nitVisibilityFloor).map((n) =>
      answeredNoteKey({ id: n.id ?? "", title: n.title }),
    ),
  );
  const isSuppressedNit = (f: Finding): boolean =>
    f.severity === "nit" &&
    (isBelowVisibilityFloor(f, input.nitVisibilityFloor) ||
      // ALL THREE key forms the prior side can emit: the resolved id (a coded or same-path
      // synthesized prior), the answeredNoteKey form (an empty-id prior), and the bare title: key
      // (a pathless codeless prior).
      priorSuppressedKeys.has(resolveFindingId(f)) ||
      priorSuppressedKeys.has(answeredNoteKey(f)) ||
      priorSuppressedKeys.has(`title:${f.title}`));
  const suppressedNits = argued.filter(isSuppressedNit);
  const visibleFindings = argued.filter((f) => !isSuppressedNit(f));
  // The drop note, shared by every surface that renders the filtered findings: the TRUE pre-dedup
  // count (issue #151 review r5), plus — when the drops emptied the round — a line reconciling the
  // draft's verdict with the empty kept counts, so the sticky never reads "changes requested"
  // beside a converged signal without the explanation (issue #151 review r5).
  const answeredDropNote =
    [
      answeredReRaiseNote(
        [...verbatimReRaised, ...answeredSystemicFilter.verbatimReRaised],
        answeredFilter.droppedCount + answeredSystemicFilter.droppedCount,
      ),
      overruledReRaiseNote(
        [...overruledFilter.verbatimReRaised, ...overruledSystemicFilter.verbatimReRaised],
        overruledFilter.droppedCount + overruledSystemicFilter.droppedCount,
      ),
    ]
      .filter((note) => note !== "")
      .join("\n>\n") +
    (droppedCount > 0 &&
    findings.findings.length === 0 &&
    (findings.systemic_problems ?? []).length === 0
      ? "\n> _The stop signal reflects the kept findings — this round carries none._"
      : "");

  // The EXACT known set — the ids this sticky's discussion surfaces actually render: the visible
  // strays, the below-floor nits (the suppressed aside has a discussion slot), and the systemics.
  // An inline-posted finding's id is deliberately absent: the sticky renders no surface for it,
  // and its conversation lives on the inline thread itself.
  // One partition per round: the inline split below and buildInlineComments share it.
  const inlinePartition =
    input.inline === true && envelope !== null
      ? partitionFindings(visibleFindings, indexDiff(diff))
      : null;
  const straysForDiscussion = inlinePartition?.strays ?? visibleFindings;
  const currentIds = [
    ...straysForDiscussion.map((f) => f.id).filter((id) => id !== ""),
    ...suppressedNits.map((f) => f.id).filter((id) => id !== ""),
    ...(findings.systemic_problems ?? [])
      .map((s) => s.id)
      .filter((id): id is string => id !== undefined && id !== ""),
    ...contested.map((entry) => entry.id),
  ];
  // When a reply named an unknown token but the prior document could not be resolved (an expired
  // artifact, a transport failure), the trail loss is named on the surface, never silent. Only
  // ever claimed when the prior actually carries a findings marker — a marker-less prior has no
  // artifact to fail.
  const orphanResolveFailed =
    existingSticky !== null &&
    broadWantsPrior &&
    carriedFindingsMarker(existingSticky.body) !== null &&
    resolvedPrior === null;
  // The departed set is the prior document's ids MINUS every id still live this round — an
  // inline-posted finding's id persists in the prior doc while the finding is still current, so it
  // must never be published under the "no longer reports" header.
  const broadLive = new Set(broadCurrentIds);
  const departedIds = priorIdsFrom(resolvedPrior).filter((id) => !broadLive.has(id));

  // The discussion aside's reply chain (issue #246): built from the rows ALREADY fetched for the
  // sticky lookup — pure, so a round pays one history fetch total. Built whenever a sticky exists,
  // including zero-stray rounds: the orphaned bucket is exactly the case where the last stray left
  // the report, and the overwrite (issue #205) would otherwise drop the pointer trail. Hoisted above
  // the lost-envelope branch so that surface carries the same trail as the main path.
  const stickyDiscussion =
    existingSticky !== null
      ? buildStickyDiscussion(reachable, currentIds, departedIds)
      : { byFinding: {}, orphaned: {}, orphanedTotal: 0, truncated: {}, orphanedTruncated: {} };
  const discussionByFinding = stickyDiscussion.byFinding;
  const orphanedDiscussion = stickyDiscussion.orphaned;
  const orphanedTotal = stickyDiscussion.orphanedTotal;
  const discussionTruncated = stickyDiscussion.truncated;
  const orphanedTruncated = stickyDiscussion.orphanedTruncated;

  const testReport = input.testReportPath ? loadTestReport(input.testReportPath) : undefined;
  const clocDiff = input.clocDiffPath ? loadClocDiff(input.clocDiffPath) : undefined;

  // The shed operates on the VISIBLE (suppression-filtered) view — the one the sticky actually
  // renders; dropping a suppressed nit would be a pure no-op that inflates the note's count.
  const shedPriority = (f: Finding): number =>
    SEVERITIES.length - 1 - SEVERITIES.indexOf(f.severity);
  const shedOrderOf = (list: readonly Finding[]): readonly Finding[] =>
    list
      .map((f, index) => ({ f, index }))
      .sort((a, b) => shedPriority(a.f) - shedPriority(b.f) || a.index - b.index)
      .map((entry) => entry.f);
  // Body length is monotone in the shed count, so bisect the smallest count that fits the limit
  // minus the patch reserve (the disposition line and the shed-immune rejected strays the final
  // patch adds — rejected strays are immune because their inline post already failed). The
  // terminal guard: when even the all-shed body exceeds the cap, unbounded non-findings content
  // (a verbatim cloc table, a caller's template) is the culprit — the caller posts the short
  // run-summary notice instead of a 422.
  const sizeSticky = (
    renderAt: (shedCount: number) => string,
    total: number,
    // 0 where no final patch can follow (the reserve is only for the patch's additions).
    reserve: number = SHED_RESERVE,
  ): { readonly body: string; readonly shedCount: number; readonly terminal: boolean } => {
    const target = STICKY_CHAR_LIMIT - reserve - SHED_NOTE_BUDGET;
    const base = renderAt(0);
    if (base.length <= target) return { body: base, shedCount: 0, terminal: false };
    // Terminal probe FIRST: when even the all-shed body exceeds GitHub's REAL limit (a terminal
    // body is never patched, so the reserve does not apply to this decision), unbounded non-
    // findings content (a verbatim cloc table, a caller's template) is the culprit and the
    // bisect is wasted work — the caller posts the short run-summary notice instead of a 422.
    const allShed = renderAt(total);
    if (allShed.length > STICKY_CHAR_LIMIT - SHED_NOTE_BUDGET)
      return { body: "", shedCount: total, terminal: true };
    // The shed note the template adds at count > 0 makes the length non-monotone in the shed
    // count (and the discussion budget re-runs over the kept set), so the bisect yields a
    // FITTING count, not a provably minimal one — every returned body was measured.
    let low = 0;
    let high = total;
    let fitted = "";
    while (low < high) {
      const mid = (low + high) >> 1;
      const body = renderAt(mid);
      if (body.length <= target) {
        high = mid;
        fitted = body;
      } else {
        low = mid + 1;
      }
    }
    // When only the all-shed count fits (the last-shed finding is the one whose prose crossed
    // the line), no mid ever fitted — low === total and the already-computed all-shed body is
    // exactly the body the count names. Never return body:"" (a bare note is not a sticky).
    return { body: fitted !== "" ? fitted : allShed, shedCount: low, terminal: false };
  };
  // The terminal notice is rendered through the template first, then RE-MEASURED: a caller-
  // supplied template without an it.terminal branch renders the full review again, so the
  // fallback is a template-INDEPENDENT minimal notice with the seed-chain markers intact.
  // The raw head SHA, exactly as the stock template's marker renders it — the CLI rejects a
  // -- or whitespace-bearing value at the boundary, so mutating it here would only break the
  // same-head equality checks the next round relies on.
  // The fallback notice reuses the SAME terminalNotice builder the template's terminal branch
  // renders — only the markers are hand-built here (the seed chain); the prose cannot drift.
  const minimalTerminalBody = (
    findingsPointer: string,
    route: string | undefined,
    incomplete: boolean,
    summaryAvailable: boolean,
    modelNames: string,
  ): string =>
    [
      DEFAULT_MARKER,
      `<!-- reviewed-sha: ${input.headSha} -->`,
      ...(!incomplete && route !== undefined
        ? [`<!-- reviewed-route: ${route.replace(/--/g, "~~").replace(/\s+/g, " ")} -->`]
        : []),
      ...(!incomplete ? [REVIEW_COMPLETE_MARKER] : []),
      // The pointer's link form already begins with the directive; the convergence-only marker
      // does not, and a terminal surface must carry the directive either way.
      ...(findingsPointer !== ""
        ? [
            findingsPointer.startsWith(AGENTS_STOP_DIRECTIVE)
              ? findingsPointer
              : `${AGENTS_STOP_DIRECTIVE}\n${findingsPointer}`,
          ]
        : []),
      "",
      terminalNotice({
        reviewedSha: input.headSha,
        verdictBadge: verdictBadge(loadedFindings.verdict),
        route: route ?? undefined,
        postedAt: input.postedAt,
        roundsSummary: "",
        convergenceSummary: "",
        inlinePosted: 0,
        runUrl: input.runUrl,
        summaryAvailable,
        findingsDocLinked: hasFindingsMarker(findingsPointer),
        thisRunArtifact: input.jsonUrl !== undefined,
        modelNames,
      }),
    ].join("\n");
  const terminalOrMinimal = (
    terminalRender: string,
    findingsPointer: string,
    route: string | undefined,
    incomplete: boolean,
    summaryAvailable: boolean,
    modelNames: string,
  ): string =>
    terminalRender.length <= STICKY_CHAR_LIMIT
      ? terminalRender
      : minimalTerminalBody(findingsPointer, route, incomplete, summaryAvailable, modelNames);
  // Whether the run summary was actually written (appendRunSummary no-ops without the env var):
  // the refuge claims must not fire on a path where the refuge does not exist.
  const summaryAvailable = (process.env["GITHUB_STEP_SUMMARY"] ?? "") !== "";
  const modelNames =
    envelope !== null && envelope.models.length > 0
      ? envelope.models.map((m) => m.model).join(", ")
      : "";
  // A caller-supplied template may render it.strays without the it.shedCount note — the silent
  // drop the note exists to prevent. The sized body is checked and a post-built line appended
  // when the template dropped the note, the same template-independent discipline as the terminal
  // fallback.
  // The note appended is the SAME string the stock template renders (render.ts's shedNote
  // builder — single-sourced), and the match checks the built string, not template prose: a
  // caller template that drops the note gets it appended; the stock template's own note matches.
  // The pointer is a PARAMETER — the lost-envelope branch calls this before the main path's
  // findingsMarker binding exists (the TDZ crash this helper must never close over).
  const withShedNote = (body: string, shedCount: number, findingsPointer: string): string => {
    if (shedCount === 0) return body;
    const note = shedNote(
      shedCount,
      summaryAvailable,
      input.runUrl,
      hasFindingsMarker(findingsPointer),
      input.jsonUrl !== undefined,
    );
    return body.includes(note) ? body : `${body}\n\n${note}\n`;
  };

  const sharedRenderInput: PresentRenderKeys<SharedRenderKey> = {
    ...runRenderInput,
    repo: input.headRepo || input.repo,
    testReport,
    clocDiff,
    // The answered-state honesty rules apply on EVERY surface that renders the filtered
    // findings — the lost-envelope branch lists every VISIBLE finding (no inline review exists to
    // carry them) so the kept re-raises' annotations actually render, and names the drops
    // exactly like the main path (issues #151 review r1 + r2). The nit visibility floor applies
    // here too (issue #164): below-floor nits are hidden from the human list and shown only in the
    // collapsed aside — the floor is a human-visibility policy, not an inline-comment policy, so it
    // must hold on the surface that lists findings without an inline review.
    suppressedNits,
    nitVisibilityFloor: input.nitVisibilityFloor,
    answeredNotes: reRaisedNotes,
    answeredReRaiseNote: answeredDropNote,
    contested: contestedViews,
    discussionByFinding,
    orphanedDiscussion,
    orphanedTotal,
    discussionTruncated,
    orphanedTruncated,
    orphanedUnresolvable: orphanResolveFailed,
    convergenceThreshold: input.convergenceThreshold,
    unverifiedNoLogs: input.unverifiedNoLogs,
    pricedAt: input.pricedAt,
    summaryAvailable,
  };

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
    // blob unchanged rather than a new round being built (issue #174) — except on the mechanic
    // route, whose pin applies here exactly as on the main path (issue #224).
    const stampedFindings = stampConvergence(
      findings,
      effectiveRoute === "mechanic"
        ? mechanicConvergence(
            priorConv,
            input.convergenceThreshold ?? DEFAULT_CONVERGENCE_THRESHOLD,
          )
        : priorConv,
    );
    // This branch lists every visible finding, exactly like the inline-off default, so it can exceed
    // GitHub's comment limit the same way — and here a 422 is the difference between a notice and
    // nothing at all. Sized by the same shed + terminal machinery as the main path (issue #214).
    // One shared render input; the varying parts are the strays (the shed's cut), shedCount, and
    // the terminal flag.
    const lostInput: Omit<
      RenderInput,
      "inlineDisposition" | "reviewUrl" | "strays" | "shedCount" | "terminal"
    > = {
      ...sharedRenderInput,
      findings: stampedFindings,
      envelope: null,
      incomplete: envelopelessIncomplete,
      sameRootNotes: {},
      roundCount: priorRoundCount,
      convergenceRound: false,
      findingsPointer: findingsBlob(stampedFindings),
    };
    const lostRender = (opts: {
      readonly strays: readonly Finding[];
      readonly shedCount?: number;
      readonly terminal?: boolean;
    }): string =>
      formatMarkdown(
        render({
          ...lostInput,
          ...opts,
          inlineDisposition: inlineRequested ? { kind: "no-envelope" } : { kind: "disabled" },
        }),
      );
    const lostShedOrder = shedOrderOf(visibleFindings);
    const lostRenderAt = (shedCount: number): string =>
      shedCount === 0
        ? lostRender({ strays: visibleFindings })
        : (() => {
            const dropped = new Set(lostShedOrder.slice(0, shedCount));
            return lostRender({
              strays: visibleFindings.filter((f) => !dropped.has(f)),
              shedCount,
            });
          })();
    // No patch ever follows this branch, so the reserve is 0 — the shed stops at GitHub's real
    // limit.
    const lostSized = sizeSticky(lostRenderAt, visibleFindings.length, 0);
    const body = lostSized.terminal
      ? terminalOrMinimal(
          lostRender({ strays: visibleFindings, terminal: true }),
          findingsBlob(stampedFindings),
          effectiveRoute,
          envelopelessIncomplete,
          summaryAvailable,
          "",
        )
      : withShedNote(lostSized.body, lostSized.shedCount, findingsBlob(stampedFindings));
    await upsertSticky(input.repo, prNumber, existingSticky, body, ghApi, true);
    // The run summary carries the WHOLE review on this branch too — the shed's refuge claim
    // ("the run summary carries the whole review") must stay true on every path.
    appendRunSummary(process.env["GITHUB_STEP_SUMMARY"], () =>
      lostSized.shedCount === 0 ? lostSized.body : lostRender({ strays: visibleFindings }),
    );
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
        ...(inlinePartition !== null ? { partition: inlinePartition } : {}),
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

  // This round's mechanism-frequency map (findings + the codes systemic problems tie together) and the
  // true completed-round number, which numbers itself after the carried count. buildConvergence appends
  // this round's score + codes + head SHA to the carried trajectory (prior rounds verbatim) when the run
  // completes a full-review round. A mechanic pass, a notice, or an incomplete run is NOT a round: it
  // carries the prior convergence (the last completed round's, verbatim) forward, so the trajectory + last
  // score survive; render's incomplete gate keeps that off the human surface, so a carried "converged" is
  // never shown beside a run that produced no verdict (issue #141 reviews r2 + r4).
  const currentCodes = computeIdCounts(findings.findings, findings.systemic_problems ?? []);
  const roundNumber = priorRoundCount + 1;
  const convergence = isRound
    ? buildConvergence(
        findings,
        input.convergenceThreshold,
        priorTraj,
        roundNumber,
        currentCodes,
        input.headSha.slice(0, 12),
        contested,
      )
    : effectiveRoute === "mechanic"
      ? // A mechanic pass means CI failed — whatever the carried prior says, its own stamp must
        // never read "converged". The threshold-relative critical floor keeps the carried triple
        // consistent at every threshold; null (no marker) when no prior round exists (issue #224).
        mechanicConvergence(priorConv, input.convergenceThreshold ?? DEFAULT_CONVERGENCE_THRESHOLD)
      : priorConv;
  const stampedFindings = stampConvergence(findings, convergence);
  const currentRoundCount = isRound ? roundNumber : priorRoundCount;

  const findingsMarker = findingsBlob(
    stampedFindings,
    answerable && dialogueRound
      ? dialogueMarker(dialogue, priorDialogue.undecoded)
      : carriedDialogue,
  );

  const commonRenderInput: Omit<RenderInput, "inlineDisposition" | "reviewUrl"> = {
    ...sharedRenderInput,
    findings: withoutIds(stampedFindings, contestedIds),
    envelope,
    incomplete: thisIncomplete,
    sameRootNotes,
    roundCount: currentRoundCount,
    convergenceRound: isRound,
    strays,
    findingsPointer: findingsMarker,
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
    discussionOverride?: Pick<
      RenderInput,
      | "discussionByFinding"
      | "orphanedDiscussion"
      | "orphanedTotal"
      | "discussionTruncated"
      | "orphanedTruncated"
    >,
    terminal = false,
    shedCount = 0,
  ): string =>
    formatMarkdown(
      render({
        ...commonRenderInput,
        ...(straysOverride ? { strays: straysOverride } : {}),
        ...(unanchoredCount !== undefined ? { unanchoredCount } : {}),
        ...(unanchoredStrays !== undefined && unanchoredStrays.length > 0
          ? { unanchoredStrays }
          : {}),
        ...(discussionOverride ?? {}),
        ...(terminal ? { terminal } : {}),
        ...(shedCount > 0 ? { shedCount } : {}),
        inlineDisposition,
        reviewUrl,
      }) + longFilesNote,
    );

  // GitHub rejects a comment over 65536 chars, and postComment/patchComment let that 422 propagate,
  // so the body is sized HERE, before the write (issue #214): the findings shed least-severe-first
  // until the body fits the limit minus the patch reserve (the disposition line and the
  // GitHub-rejected strays the final patch adds — those strays are shed-immune by construction:
  // their inline post already failed, so the sticky is the only human surface they have). The
  // embedded blob is gone from this body (issue #217), so the shed now trades in finding prose
  // only; the run summary renders the WHOLE review with no size limit and is the shed's refuge
  // (issue #205). A failed write AFTER the sticky is up degrades instead of aborting (issue #223).
  // The shed's universe is the sticky's own render universe — the strays — so the count the
  // note names is exactly what the comment lost (an in-diff finding is never in the comment).
  // The kept list keeps the DOCUMENT order: the shed decides WHAT is dropped, the document
  // decides HOW the kept findings are listed.
  const mainShedOrder = shedOrderOf(strays);
  const mainRenderAt = (shedCount: number): string =>
    shedCount === 0
      ? renderBody(initialDisposition)
      : renderBody(
          initialDisposition,
          undefined,
          strays.filter((f) => !new Set(mainShedOrder.slice(0, shedCount)).has(f)),
          undefined,
          undefined,
          undefined,
          false,
          shedCount,
        );
  // The reserve over-sheds when the patch it funds never runs (the review POST failed wholesale,
  // or every raw comment was dropped) — accepted: patching the sticky back up after a failed
  // review POST costs a second write for a degraded round, and the patch re-fits on its own.
  const mainSized = sizeSticky(
    mainRenderAt,
    strays.length,
    inlineRequested && rawComments.length > 0 ? SHED_RESERVE : 0,
  );
  const fitStickyBody = (): string =>
    mainSized.terminal
      ? terminalOrMinimal(
          renderBody(
            initialDisposition,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
          ),
          findingsMarker,
          effectiveRoute,
          thisIncomplete,
          summaryAvailable,
          modelNames,
        )
      : withShedNote(mainSized.body, mainSized.shedCount, findingsMarker);

  // Phase 2: writes — sticky first, inline second. The carry is a property of the rendered body
  // (findingsBlob above), so every write site gets it for free.
  const stickyRef = await upsertSticky(
    input.repo,
    prNumber,
    existingSticky,
    fitStickyBody(),
    ghApi,
    true,
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
    posted: reviewObjectPosted,
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
    reviewObjectPosted
      ? inlineRequested
        ? `Posted a review with ${String(inlinePosted)} inline comment(s) on PR #${String(prNumber)}\n`
        : `Posted a body-only review on PR #${String(prNumber)}; the findings are in the sticky\n`
      : inlinePosted > 0
        ? `No review object posted this round on PR #${String(prNumber)}, but ${String(inlinePosted)} inline comment(s) anchored — the sticky carries the review\n`
        : `No review object posted this round on PR #${String(prNumber)} — the sticky carries the review\n`,
  );

  // The dismiss and minimize are gated on a BREADCRUMB review being POSTED this round: when the
  // POST failed, the prior round's reviews and threads are the only diff-anchored review objects
  // and must stay — a permanent failure (a short-scoped token, a recurring stale SHA) must not
  // clear them every round (issue #223). (The POST's success, not the parsed url — an unparseable
  // response still means the object exists.)
  const priorReviewIds = botReviews.map((r) => r.id);
  if (reviewObjectPosted && priorReviewIds.length > 0) {
    await dismissReviews(input.repo, prNumber, priorReviewIds, ghApi);
  }
  if (reviewObjectPosted || inlinePosted > 0) {
    await minimizeComments(prNumber, priorInlineComments, ghApi);
  }

  // Re-render the sticky to the truth: "posted N" is the count that ACTUALLY anchored, any
  // GitHub-rejected in-diff findings join the strays, and none-anchored says "inline unavailable",
  // never a false "posted". Best-effort — the sticky and review are already posted.
  const unanchoredCount = unposted.length;
  // GitHub-rejected in-diff findings render on the final sticky as strays — the discussion grouping
  // was built before their rejection was knowable, so it is rebuilt with their ids in the known set:
  // their asides render, and their replies never land in the "no longer reports" bucket.
  const finalDiscussion =
    unanchoredCount > 0
      ? buildStickyDiscussion(
          reachable,
          [...currentIds, ...unposted.map((f) => f.id).filter((id) => id !== "")],
          departedIds,
        )
      : null;
  const finalDiscussionOverride =
    finalDiscussion !== null
      ? {
          discussionByFinding: finalDiscussion.byFinding,
          orphanedDiscussion: finalDiscussion.orphaned,
          orphanedTotal: finalDiscussion.orphanedTotal,
          discussionTruncated: finalDiscussion.truncated,
          orphanedTruncated: finalDiscussion.orphanedTruncated,
        }
      : undefined;
  if (stickyRef !== null && (inlinePosted > 0 || unanchoredCount > 0)) {
    const finalDisposition: InlineDisposition =
      inlinePosted > 0
        ? { kind: "posted", count: inlinePosted, sha: input.headSha }
        : { kind: "inline-unavailable" };
    if (mainSized.terminal) {
      // The terminal sticky must not understate where the review lives: the inline review IS
      // posted, so a short patch adds the disposition line (the terminal body is tiny).
      try {
        const terminalPatch = renderBody(
          finalDisposition,
          reviewUrl,
          undefined,
          unanchoredCount,
          unposted,
          finalDiscussionOverride,
          true,
        );
        if (terminalPatch.length <= STICKY_CHAR_LIMIT) {
          await patchComment(input.repo, stickyRef.id, terminalPatch, ghApi);
          process.stderr.write(
            `Updated sticky comment #${String(stickyRef.id)} to reflect the review\n`,
          );
        } else {
          process.stderr.write(
            `Warning: the terminal sticky patch exceeds GitHub's comment limit — the sticky stands; the run summary carries the review\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `Warning: failed to update the terminal sticky after the review: ${errMsg(err)}\n`,
        );
      }
    } else {
      // The patch re-sizes against the same limit: its additions (the disposition, the immune
      // rejected strays, the rebuilt discussion) can push the body past the initial reserve, so
      // the shed re-fits from scratch — the rejected strays stay immune either way.
      const patchShedOrder = shedOrderOf(strays);
      const patchRenderAt = (shedCount: number): string =>
        renderBody(
          finalDisposition,
          reviewUrl,
          [
            ...unposted,
            ...(shedCount === 0
              ? strays
              : strays.filter((f) => !new Set(patchShedOrder.slice(0, shedCount)).has(f))),
          ],
          unanchoredCount,
          unposted,
          finalDiscussionOverride,
          false,
          shedCount,
        );
      // The patch is the last write — no reserve.
      const patchSized = sizeSticky(patchRenderAt, strays.length, 0);
      try {
        if (patchSized.terminal) {
          process.stderr.write(
            `Warning: the final sticky patch still exceeds GitHub's comment limit — the sticky stands as posted${
              summaryAvailable
                ? "; the whole review (rejected findings included) is in the run summary"
                : ""
            }\n`,
          );
        } else {
          await patchComment(
            input.repo,
            stickyRef.id,
            withShedNote(patchSized.body, patchSized.shedCount, findingsMarker),
            ghApi,
          );
          process.stderr.write(
            `Updated sticky comment #${String(stickyRef.id)} to reflect the review\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `Warning: failed to update the sticky summary after the review: ${errMsg(err)}\n`,
        );
      }
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
      // path-only links here too (issue #231 r2). Unconditional: renderBody's own gate treats an
      // empty array exactly like absence, so the ternary was a duplicated decision (issue #231 r3).
      unposted,
      // The summary is the sticky's long-lived twin — a rejected finding's rebuilt discussion
      // trail renders here exactly as on the final patch.
      finalDiscussionOverride,
    ),
  );
  if (answerable && dialogueRound) {
    appendRunSummary(process.env["GITHUB_STEP_SUMMARY"], () => {
      const comparedPrior = resolvedPrior === null ? null : resolveTolerantFindings(resolvedPrior);
      const answeredIds = new Set(allAnswers.map((answer) => answer.id));
      return dialogueMetricsTable({
        commentAnswers: answers.comments.length,
        commitAnswers: answers.commits.length,
        closures: allClosures.length,
        droppedAnswered: answeredFilter.droppedCount + answeredSystemicFilter.droppedCount,
        droppedOverruled: overruledFilter.droppedCount + overruledSystemicFilter.droppedCount,
        annotated: Object.keys(reRaisedNotes).length,
        entries: dialogue,
        nearMisses:
          comparedPrior === null
            ? null
            : reMintedNearMisses(
                loadedFindings,
                comparedPrior,
                new Set(allClosures.map((closure) => closure.id)),
              ),
        systemicUnanswered: (findings.systemic_problems ?? []).filter((s) => {
          const id = resolveSystemicId(s);
          return id === undefined || !answeredIds.has(id);
        }).length,
      });
    });
  }
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
