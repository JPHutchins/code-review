// Shares post's PR resolution so the review and comment jobs never split-brain on which PR.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as t from "io-ts";
import { execFileWithTimeout, subprocessTimeoutMs } from "./exec.js";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
import { fetchDiff, fetchPrCandidates, resolvePr } from "./pr.js";
import { parseJsonl } from "./transcript.js";
import {
  answeredRegistryFrom,
  encodeAnsweredEntry,
  ThreadCommentCodec,
  THREAD_COMMENT_JQ,
} from "./answered.js";
import { errMsg } from "./util.js";

export interface GatherInput {
  readonly repo: string;
  readonly headSha: string;
  readonly headBranch?: string;
  // The repo's default branch — the trusted base the review checks out and the reference point for
  // the full (triage) diff. A PR whose base is a different branch is "stacked".
  readonly defaultBranch: string;
  readonly runId: string;
  readonly conclusion: string;
  readonly botLogin: string;
  readonly outDir: string;
}

export type GatherResult =
  | { readonly kind: "skip" }
  | {
      readonly kind: "gathered";
      readonly pr: number;
      readonly conclusion: string;
      readonly diffSize: number;
      // The PR's base is not the default branch (a stacked PR): the review scope (base...head) is a
      // strict subset of what gets checked out + triaged (default...head), so the review prompt frames
      // the extra changes as already-reviewed context.
      readonly stacked: boolean;
    };

export const renderOutputs = (result: GatherResult): string => {
  switch (result.kind) {
    case "skip":
      return "skip=true\n";
    case "gathered":
      return `pr=${String(result.pr)}\nconclusion=${result.conclusion}\ndiff_size=${String(result.diffSize)}\nstacked=${String(result.stacked)}\n`;
  }
};

export type GitRun = (args: readonly string[]) => Promise<string>;

export const runGit: GitRun = (args) =>
  execFileWithTimeout({
    command: "git",
    args,
    label: `git ${args.join(" ")}`,
    timeoutMs: subprocessTimeoutMs(),
  });

const PrMetaCodec = t.type({
  changed_files: t.number,
  base_sha: t.string,
  base_ref: t.string,
  title: t.string,
  body: t.union([t.string, t.null]),
});
type PrMeta = t.TypeOf<typeof PrMetaCodec>;

const IssueCommentCodec = t.intersection([
  t.type({
    id: t.number,
    body: t.union([t.string, t.null]),
    user: t.type({ login: t.string }),
  }),
  t.partial({
    created_at: t.union([t.string, t.null]),
    author_association: t.union([t.string, t.null]),
  }),
]);
type IssueComment = t.TypeOf<typeof IssueCommentCodec>;

const JobCodec = t.type({ id: t.number, conclusion: t.union([t.string, t.null]) });
const JobsResponseCodec = t.type({ jobs: t.array(JobCodec) });

const fetchPrMeta = async (repo: string, prNumber: number, ghApi: GhApi): Promise<PrMeta> => {
  const stdout = await ghApi([
    `repos/${repo}/pulls/${String(prNumber)}`,
    "--jq",
    "{changed_files: .changed_files, base_sha: .base.sha, base_ref: .base.ref, title: .title, body: .body}",
  ]);
  const decoded = PrMetaCodec.decode(JSON.parse(stdout) as unknown);
  if (decoded._tag === "Left") {
    throw new Error(`PR metadata for #${String(prNumber)} did not match the expected shape`);
  }
  return decoded.right;
};

const fetchApiDiff = async (
  repo: string,
  prNumber: number,
  ghApi: GhApi,
): Promise<string | null> => {
  try {
    return await fetchDiff(repo, prNumber, ghApi);
  } catch {
    return null;
  }
};

// The review checks out the PR head; the untrusted surface a checkout exposes over the trusted
// default branch is exactly `default...head`. So triage scans THIS diff (not the PR's base...head),
// and it is the same diff for a normal PR (base === default). Compare API with a git-diff fallback
// (fetch the head, diff from the checked-out default-branch tip) mirroring the pr.diff path.
const fetchFullDiff = async (
  repo: string,
  defaultBranch: string,
  headSha: string,
  ghApi: GhApi,
  gitRun: GitRun,
): Promise<string> => {
  try {
    const diff = await ghApi([
      `repos/${repo}/compare/${defaultBranch}...${headSha}`,
      "-H",
      "Accept: application/vnd.github.v3.diff",
    ]);
    if (diff.length > 0) return diff;
    process.stderr.write(
      `compare diff for ${defaultBranch}...${headSha} was empty — falling back to git diff\n`,
    );
  } catch (err) {
    process.stderr.write(`compare diff fetch failed (${errMsg(err)}) — falling back to git diff\n`);
  }
  await gitRun(["fetch", "origin", headSha]);
  // Three-dot, matching the compare API's semantics (merge-base...head): the checked-out default
  // branch is HEAD, so this is the same untrusted surface the compare primary computes.
  const base = (await gitRun(["rev-parse", "HEAD"])).trim();
  return gitRun(["diff", `${base}...${headSha}`]);
};

const CommitCodec = t.type({
  sha: t.string,
  message: t.string,
  author: t.union([t.string, t.null]),
  email: t.union([t.string, t.null]),
});
const COMMIT_JQ =
  ".commits[] | {sha: .sha, message: .commit.message, author: .commit.author.name, email: .commit.author.email}";

// Commit messages + author identities of every commit in `default...head`. Once the head is checked
// out, `git log` exposes these to the reviewing agent, so they are an untrusted surface triage must
// scan for injection. FAIL CLOSED: a fetch failure propagates (never a silent empty scan) — the
// caller must not expose commit messages it could not vet.
const fetchCompareCommits = async (
  repo: string,
  defaultBranch: string,
  headSha: string,
  ghApi: GhApi,
): Promise<readonly t.TypeOf<typeof CommitCodec>[]> => {
  const rows = parseJsonl(
    await ghApi([
      `repos/${repo}/compare/${defaultBranch}...${headSha}`,
      "--paginate",
      "--jq",
      COMMIT_JQ,
    ]),
  );
  const decoded = rows.map((row) => CommitCodec.decode(row));
  const commits = decoded.flatMap((d) => (d._tag === "Right" ? [d.right] : []));
  // A dropped row is a scan gap, not a no-op: a checkout's `git log` still exposes that commit's
  // message to the agent, so name any drop rather than let an unscanned message pass silently.
  const dropped = decoded.length - commits.length;
  if (dropped > 0) {
    process.stderr.write(
      `Warning: ${String(dropped)} of ${String(rows.length)} commit row(s) failed to decode — their messages are NOT in the triage scan though a checkout's git log still exposes them\n`,
    );
  }
  return commits;
};

// One object per row across all pages: `--paginate` WITHOUT `--jq` concatenates each page's JSON
// array into an invalid `[..][..]` stream JSON.parse rejects, silently losing the prior review (and
// the conversation) on any PR past the first page; the `--jq` projection streams NDJSON parseJsonl
// reads line by line — the shape post.ts's findBotComment already uses.
const COMMENT_JQ =
  ".[] | {id: .id, body: .body, user: {login: .user.login}, created_at: .created_at, author_association: .author_association}";
// The review-comments fetch feeds TWO consumers from one projection: the conversation (human
// replies, via ReviewCommentCodec) and the answered-findings registry (thread structure + the bot's
// own comments, via ThreadCommentCodec) — the richer THREAD_COMMENT_JQ shape serves both, the
// conversation codec tolerating the extra fields.
const REVIEW_COMMENT_JQ = THREAD_COMMENT_JQ;
const REVIEW_JQ =
  ".[] | {body: .body, user: {login: .user.login}, submitted_at: .submitted_at, author_association: .author_association, state: .state}";

const ReviewCommentCodec = t.intersection([
  t.type({ body: t.union([t.string, t.null]), user: t.type({ login: t.string }) }),
  t.partial({
    created_at: t.union([t.string, t.null]),
    author_association: t.union([t.string, t.null]),
    path: t.union([t.string, t.null]),
    line: t.union([t.number, t.null]),
  }),
]);
type ReviewComment = t.TypeOf<typeof ReviewCommentCodec>;

const ReviewCodec = t.intersection([
  t.type({ body: t.union([t.string, t.null]), user: t.type({ login: t.string }) }),
  t.partial({
    submitted_at: t.union([t.string, t.null]),
    author_association: t.union([t.string, t.null]),
    state: t.union([t.string, t.null]),
  }),
]);
type Review = t.TypeOf<typeof ReviewCodec>;

// Fetch + stream-parse a paginated endpoint; null on any transport error (named on stderr so a
// degraded channel is diagnosable), so a failed fetch never aborts the review — the conversation is
// best-effort context.
const fetchJsonlRows = async (
  ghApi: GhApi,
  endpoint: string,
  jq: string,
): Promise<readonly unknown[] | null> => {
  try {
    return parseJsonl(await ghApi([endpoint, "--paginate", "--jq", jq]));
  } catch (err) {
    process.stderr.write(
      `Warning: could not fetch ${endpoint} (${errMsg(err)}) — omitting it from the review context\n`,
    );
    return null;
  }
};

// Decode row by row, dropping only the rows that don't validate (e.g. a deleted account's null login)
// rather than letting one malformed row fail the whole channel the way an atomic `t.array` decode
// would. null still propagates a failed fetch (rows === null); a bad row is silently skipped.
const decodeArrayOrNull = <A>(
  codec: t.Type<A>,
  rows: readonly unknown[] | null,
): readonly A[] | null => {
  if (rows === null) return null;
  return rows.flatMap((row) => {
    const decoded = codec.decode(row);
    return decoded._tag === "Right" ? [decoded.right] : [];
  });
};

// The bot's own last comment — its embedded findings marker seeds the re-review draft (seed-draft).
const priorReviewFrom = (
  comments: readonly IssueComment[],
  botLogin: string,
): { readonly id: number; readonly body: string | null } | null => {
  const byBot = comments.filter((c) => c.user.login === botLogin);
  const last = byBot[byBot.length - 1];
  return last ? { id: last.id, body: last.body } : null;
};

// The untrusted PR discussion staged for the review agent to TRIAGE as claims — so a re-review can
// recognize a finding the author already answered without OBEYING the comment. Everyone but the
// review bot (its own output is seeded back via prior_review), bounded to the most recent items per
// channel with each body clipped so a long thread can't blow the agent's context; the workflow frames
// these files as claims-to-verify, never as instructions.
const MAX_CONVERSATION_COMMENTS = 50;
const MAX_CONVERSATION_BODY_CHARS = 4000;

const clip = (body: string): string => {
  if (body.length <= MAX_CONVERSATION_BODY_CHARS) return body;
  const cut = body.slice(0, MAX_CONVERSATION_BODY_CHARS);
  // Don't end on a lone high surrogate (a code point split mid-pair) — drop it so the kept prefix
  // stays well-formed UTF-16.
  const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${safe}\n… [truncated]`;
};

// Drop the review bot and empty bodies, keep the most recent MAX (logging when it caps), then project.
const boundedHuman = <
  A extends { readonly user: { readonly login: string }; readonly body: string | null },
  B,
>(
  items: readonly A[],
  botLogin: string,
  label: string,
  project: (item: A & { readonly body: string }) => B,
): readonly B[] => {
  const human = items.filter(
    (a): a is A & { readonly body: string } =>
      a.user.login !== botLogin && typeof a.body === "string" && a.body.trim() !== "",
  );
  const kept = human.slice(-MAX_CONVERSATION_COMMENTS);
  if (kept.length < human.length) {
    process.stderr.write(
      `Note: PR has ${String(human.length)} ${label} — feeding the review the most recent ${String(MAX_CONVERSATION_COMMENTS)}\n`,
    );
  }
  return kept.map(project);
};

const issueCommentsFrom = (comments: readonly IssueComment[], botLogin: string) =>
  boundedHuman(comments, botLogin, "discussion comments", (c) => ({
    author: c.user.login,
    author_association: c.author_association ?? null,
    created_at: c.created_at ?? null,
    body: clip(c.body),
  }));

const reviewCommentsFrom = (comments: readonly ReviewComment[], botLogin: string) =>
  boundedHuman(comments, botLogin, "inline review comments", (c) => ({
    author: c.user.login,
    author_association: c.author_association ?? null,
    created_at: c.created_at ?? null,
    path: c.path ?? null,
    line: c.line ?? null,
    body: clip(c.body),
  }));

const reviewsFrom = (reviews: readonly Review[], botLogin: string) =>
  boundedHuman(reviews, botLogin, "review submissions", (r) => ({
    author: r.user.login,
    author_association: r.author_association ?? null,
    submitted_at: r.submitted_at ?? null,
    state: r.state ?? null,
    body: clip(r.body),
  }));

// Jobs-list failure is fatal; a per-log download failure degrades — logs are advisory, and partial
// logs plus the diff beat a dead review.
const downloadFailingJobLogs = async (
  repo: string,
  runId: string,
  outDir: string,
  ghApi: GhApi,
): Promise<void> => {
  const stdout = await ghApi([`repos/${repo}/actions/runs/${runId}/jobs`]);
  const decoded = JobsResponseCodec.decode(JSON.parse(stdout) as unknown);
  if (decoded._tag === "Left") {
    throw new Error(`Jobs list for run ${runId} did not match the expected shape`);
  }
  for (const job of decoded.right.jobs.filter((j) => j.conclusion === "failure")) {
    try {
      const log = await ghApi([`repos/${repo}/actions/jobs/${String(job.id)}/logs`]);
      writeFileSync(join(outDir, `job_${String(job.id)}.log`), log);
    } catch (err) {
      process.stderr.write(
        `Warning: failed to download logs for job ${String(job.id)}: ${errMsg(err)} — continuing with the logs retrieved so far\n`,
      );
    }
  }
};

export const gather = async (
  input: GatherInput,
  ghApi: GhApi = runGhApi,
  gitRun: GitRun = runGit,
): Promise<GatherResult> => {
  const candidates = await fetchPrCandidates(input.repo, input.headSha, ghApi);
  const resolution = resolvePr(candidates, input.headBranch);
  if (resolution.kind === "none") {
    process.stderr.write(`No open PR for ${input.headSha} — nothing to review\n`);
    return { kind: "skip" };
  }
  if (resolution.kind === "not-open") {
    process.stderr.write(
      `PR #${String(resolution.prNumber)} for ${input.headSha} is not open (state: ${resolution.state}) — nothing to review\n`,
    );
    return { kind: "skip" };
  }
  const prNumber = resolution.prNumber;

  const meta = await fetchPrMeta(input.repo, prNumber, ghApi);

  const stacked = meta.base_ref !== input.defaultBranch;

  // pr.diff (base...head) is the review SCOPE — the PR's own change; its endpoint + git-diff fallback
  // are unchanged.
  const prDiff = await (async () => {
    const apiDiff = await fetchApiDiff(input.repo, prNumber, ghApi);
    if (apiDiff !== null && !(apiDiff.length === 0 && meta.changed_files > 0)) return apiDiff;
    process.stderr.write(
      `PR diff fetch failed or was empty for ${String(meta.changed_files)} changed files — falling back to git diff\n`,
    );
    await gitRun(["fetch", "origin", input.headSha]);
    return gitRun(["diff", meta.base_sha, input.headSha]);
  })();

  // full.diff (default...head) is the surface a head checkout exposes over the trusted base — what
  // triage scans and what the checkout produces. Same as pr.diff for a normal PR (base === default);
  // a superset for a stacked one, so only then is a separate fetch needed. commits.json carries the
  // messages/authors a checked-out `git log` exposes, scanned by triage alongside the diff.
  const fullDiff = stacked
    ? await fetchFullDiff(input.repo, input.defaultBranch, input.headSha, ghApi, gitRun)
    : prDiff;
  const commits = await fetchCompareCommits(input.repo, input.defaultBranch, input.headSha, ghApi);

  writeFileSync(join(input.outDir, "full.diff"), fullDiff);
  writeFileSync(join(input.outDir, "pr.diff"), prDiff);
  writeFileSync(join(input.outDir, "commits.json"), JSON.stringify(commits));
  writeFileSync(
    join(input.outDir, "pr_context.json"),
    JSON.stringify({ title: meta.title, body: meta.body }),
  );

  // The three conversation fetches are independent — run them together rather than one after another.
  const [issueRows, reviewCommentRows, reviewRows] = await Promise.all([
    fetchJsonlRows(ghApi, `repos/${input.repo}/issues/${String(prNumber)}/comments`, COMMENT_JQ),
    fetchJsonlRows(
      ghApi,
      `repos/${input.repo}/pulls/${String(prNumber)}/comments`,
      REVIEW_COMMENT_JQ,
    ),
    fetchJsonlRows(ghApi, `repos/${input.repo}/pulls/${String(prNumber)}/reviews`, REVIEW_JQ),
  ]);
  const issueComments = decodeArrayOrNull(IssueCommentCodec, issueRows);
  const reviewComments = decodeArrayOrNull(ReviewCommentCodec, reviewCommentRows);
  const threadComments = decodeArrayOrNull(ThreadCommentCodec, reviewCommentRows);
  const reviews = decodeArrayOrNull(ReviewCodec, reviewRows);

  const prior = issueComments === null ? null : priorReviewFrom(issueComments, input.botLogin);
  writeFileSync(
    join(input.outDir, "prior_review.json"),
    prior === null ? "null" : JSON.stringify(prior),
  );
  // The "already answered" registry (issue #151): the prior inline findings whose threads a human
  // reply answered — staged for seed-draft to deliver beside the prior context, so the next-round
  // agent sees what it must not re-raise verbatim. Best-effort like the conversation: a failed fetch
  // yields [] (the agent then relies on the conversation alone).
  const answered =
    threadComments === null ? [] : answeredRegistryFrom(threadComments, input.botLogin);
  writeFileSync(
    join(input.outDir, "answered.json"),
    JSON.stringify(answered.map(encodeAnsweredEntry)),
  );
  writeFileSync(
    join(input.outDir, "pr_conversation.json"),
    JSON.stringify({
      issue_comments:
        issueComments === null ? [] : issueCommentsFrom(issueComments, input.botLogin),
      review_comments:
        reviewComments === null ? [] : reviewCommentsFrom(reviewComments, input.botLogin),
      reviews: reviews === null ? [] : reviewsFrom(reviews, input.botLogin),
    }),
  );

  if (input.conclusion === "failure") {
    await downloadFailingJobLogs(input.repo, input.runId, input.outDir, ghApi);
  }

  return {
    kind: "gathered",
    pr: prNumber,
    conclusion: input.conclusion,
    diffSize: Buffer.byteLength(prDiff, "utf8"),
    stacked,
  };
};
