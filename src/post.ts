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
  /** Preformatted UTC post time, rendered on the sticky's dedicated "Reviewed `<sha>` · <postedAt>"
   *  line (issue #28) — computed by the caller (index.ts's post command) via `formatUtc`, not here,
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

/** Post the inline review, pointing its body at the sticky (issue #11) when the sticky's URL is
 *  known, and prepending the precomputed findings-json marker (issue #19) so the review body
 *  carries it too. Returns the review's own `html_url` (undefined on a malformed response) so the
 *  caller can link the sticky back to it. */
const postInlineReview = async (
  repo: string,
  prNumber: number,
  headSha: string,
  comments: readonly InlineComment[],
  stickyUrl: string | undefined,
  marker: string,
  ghApi: GhApi,
): Promise<string | undefined> => {
  const pointer = reviewBodyPointer(headSha, stickyUrl, marker);
  const body = JSON.stringify({
    body: pointer,
    commit_id: headSha,
    event: "COMMENT",
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      ...(c.start_line !== undefined && c.start_side !== undefined
        ? { start_line: c.start_line, start_side: c.start_side }
        : {}),
      body: formatMarkdown(c.body),
    })),
  });
  const stdout = await ghApi(
    [`repos/${repo}/pulls/${String(prNumber)}/reviews`, "--input", "-"],
    body,
  );
  return parseHtmlUrl(stdout);
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

/** A non-dismissed bot-authored review, carrying the commit it reviewed (SPEC §5.2.6 — review
 *  identity is the reviews API `commit_id`, not the sticky's `reviewed-sha` marker). */
interface BotReviewRef {
  readonly id: number;
  readonly commitId: string;
}

const isBotReview = (
  r: unknown,
): r is { id: number; user: { login: string }; state: string; commit_id?: unknown } =>
  typeof r === "object" &&
  r !== null &&
  typeof (r as { id?: unknown }).id === "number" &&
  typeof (r as { state?: unknown }).state === "string" &&
  typeof (r as { user?: { login?: unknown } }).user?.login === "string";

/** List the PR's non-dismissed bot-authored reviews with the SHA each one reviewed. */
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
    .map((r) => ({
      id: r.id,
      commitId: typeof r.commit_id === "string" ? r.commit_id : "",
    }));
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

  // Issue #19 + review fix #5: base64-encode the findings ONCE and reuse the marker across every
  // surface (both sticky renders, each inline comment, the review body) instead of recomputing it.
  const findingsMarker = findingsPointer(findings, input.jsonUrl);

  const { comments: rawComments, strays } = buildInlineComments(findings.findings, diff, {
    inlineTemplate,
    models: envelope.models.map((m) => m.model),
    findingsPointer: findingsMarker,
  });
  const { comments, longFiles } = checkLongSuggestions(rawComments);
  for (const wf of longFiles) {
    process.stderr.write(
      `Warning: suggestion in ${wf} exceeds ${String(MAX_SUGGESTION_LINES)} lines — omitted from inline to avoid 422\n`,
    );
  }

  // Fix #5 (SPEC §5.2.6): suppression turns on whether a COMPLETED bot review already exists for
  // this head SHA — review identity via the reviews API `commit_id` — not on the sticky's marker
  // (a placeholder/degraded sticky must not claim the SHA). Only relevant when there is an inline
  // review to post at all.
  const botReviews =
    comments.length > 0 ? await fetchBotReviews(input.repo, prNumber, input.botLogin, ghApi) : [];
  const alreadyReviewedThisSha = botReviews.some((r) => r.commitId === input.headSha);

  // Issue #21: the "posted — see the review" disposition is constructed ONLY from the actual
  // postInlineReview result below, never optimistically — a review that doesn't yet exist (or
  // never will, if this process dies before posting it) must never be claimed. Everything knowable
  // from reads alone (suppression, no-in-diff-findings) is truthful up front and stays as-is.
  const initialDisposition: InlineDisposition | undefined =
    comments.length > 0
      ? alreadyReviewedThisSha
        ? { kind: "suppressed-existing-review", sha: input.headSha }
        : undefined
      : strays.length > 0
        ? { kind: "none-in-diff" }
        : undefined;

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
  ): string =>
    formatMarkdown(render({ ...commonRenderInput, inlineDisposition, reviewUrl }) + longFilesNote);

  // Phase 2 (CO-R3): writes — sticky first, inline second; failure exits non-zero.
  const stickyRef = await upsertSticky(
    input.repo,
    prNumber,
    existingSticky,
    renderBody(initialDisposition),
    ghApi,
  );

  if (comments.length === 0) return;

  if (alreadyReviewedThisSha) {
    process.stderr.write(
      `A completed bot review already exists for ${input.headSha} — updated sticky only, no new inline review\n`,
    );
    return;
  }

  // REC-CO-2: supersede prior bot reviews left on OTHER commits before posting the fresh one.
  const stalePriorReviewIds = botReviews
    .filter((r) => r.commitId !== input.headSha)
    .map((r) => r.id);
  if (stalePriorReviewIds.length > 0) {
    await dismissReviews(input.repo, prNumber, stalePriorReviewIds, ghApi);
  }

  const reviewUrl = await postInlineReview(
    input.repo,
    prNumber,
    input.headSha,
    comments,
    stickyRef?.url,
    findingsMarker,
    ghApi,
  );
  process.stderr.write(
    `Posted ${String(comments.length)} inline comments on PR #${String(prNumber)}\n`,
  );

  // Issue #11/#21: now that postInlineReview has actually resolved, the sticky can truthfully
  // report the review — with a link when reviewUrl parsed, as plain text otherwise (still true:
  // the review was posted; only its URL is unknown). Best-effort — the sticky and review are
  // already posted, so a failure here (a bad response, a network hiccup) must never fail the job.
  if (stickyRef !== null) {
    const confirmedDisposition: InlineDisposition = {
      kind: "posted",
      count: comments.length,
      sha: input.headSha,
    };
    try {
      await patchComment(
        input.repo,
        stickyRef.id,
        renderBody(confirmedDisposition, reviewUrl),
        ghApi,
      );
      process.stderr.write(`Linked sticky comment #${String(stickyRef.id)} to the review\n`);
    } catch (err) {
      process.stderr.write(
        `Warning: failed to link the sticky summary to the review: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
};
