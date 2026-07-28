// Shares post's PR resolution so the review and comment jobs never split-brain on which PR.

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as t from "io-ts";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
import { fetchDiff, fetchPrCandidates, resolvePr } from "./pr.js";
import { parseJsonl } from "./transcript.js";
import { errMsg } from "./util.js";

export interface GatherInput {
  readonly repo: string;
  readonly headSha: string;
  readonly headBranch?: string;
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
    };

export const renderOutputs = (result: GatherResult): string => {
  switch (result.kind) {
    case "skip":
      return "skip=true\n";
    case "gathered":
      return `pr=${String(result.pr)}\nconclusion=${result.conclusion}\ndiff_size=${String(result.diffSize)}\n`;
  }
};

export type GitRun = (args: readonly string[]) => Promise<string>;

export const runGit: GitRun = (args) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const stderrStr = typeof stderr === "string" && stderr.trim() ? stderr.trim() : "";
          const errStr = err instanceof Error ? err.message : "unknown error";
          reject(new Error(`git ${args.join(" ")} failed: ${stderrStr || errStr}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });

const PrMetaCodec = t.type({
  changed_files: t.number,
  base_sha: t.string,
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
    "{changed_files: .changed_files, base_sha: .base.sha, title: .title, body: .body}",
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

// One object per row across all pages: `--paginate` WITHOUT `--jq` concatenates each page's JSON
// array into an invalid `[..][..]` stream JSON.parse rejects, silently losing the prior review (and
// the conversation) on any PR past the first page; the `--jq` projection streams NDJSON parseJsonl
// reads line by line — the shape post.ts's findBotComment already uses.
const COMMENT_JQ =
  ".[] | {id: .id, body: .body, user: {login: .user.login}, created_at: .created_at, author_association: .author_association}";
const REVIEW_COMMENT_JQ =
  ".[] | {body: .body, user: {login: .user.login}, created_at: .created_at, author_association: .author_association, path: .path, line: .line}";
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

// Fetch + stream-parse a paginated endpoint; null on any transport error, so a degraded fetch never
// aborts the review — the conversation is best-effort context.
const fetchJsonlRows = async (
  ghApi: GhApi,
  endpoint: string,
  jq: string,
): Promise<readonly unknown[] | null> => {
  try {
    return parseJsonl(await ghApi([endpoint, "--paginate", "--jq", jq]));
  } catch {
    return null;
  }
};

const decodeArrayOrNull = <A>(
  codec: t.Type<A>,
  rows: readonly unknown[] | null,
): readonly A[] | null => {
  if (rows === null) return null;
  const decoded = t.array(codec).decode(rows);
  return decoded._tag === "Left" ? null : decoded.right;
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

const clip = (body: string): string =>
  body.length > MAX_CONVERSATION_BODY_CHARS
    ? `${body.slice(0, MAX_CONVERSATION_BODY_CHARS)}\n… [truncated]`
    : body;

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

  const apiDiff = await fetchApiDiff(input.repo, prNumber, ghApi);
  const diff =
    apiDiff !== null && !(apiDiff.length === 0 && meta.changed_files > 0)
      ? apiDiff
      : await (async () => {
          process.stderr.write(
            `PR diff fetch failed or was empty for ${String(meta.changed_files)} changed files — falling back to git diff\n`,
          );
          await gitRun(["fetch", "origin", input.headSha]);
          return gitRun(["diff", meta.base_sha, input.headSha]);
        })();

  writeFileSync(join(input.outDir, "pr.diff"), diff);
  writeFileSync(
    join(input.outDir, "pr_context.json"),
    JSON.stringify({ title: meta.title, body: meta.body }),
  );

  const issueComments = decodeArrayOrNull(
    IssueCommentCodec,
    await fetchJsonlRows(
      ghApi,
      `repos/${input.repo}/issues/${String(prNumber)}/comments`,
      COMMENT_JQ,
    ),
  );
  const prior = issueComments === null ? null : priorReviewFrom(issueComments, input.botLogin);
  writeFileSync(
    join(input.outDir, "prior_review.json"),
    prior === null ? "null" : JSON.stringify(prior),
  );

  const reviewComments = decodeArrayOrNull(
    ReviewCommentCodec,
    await fetchJsonlRows(
      ghApi,
      `repos/${input.repo}/pulls/${String(prNumber)}/comments`,
      REVIEW_COMMENT_JQ,
    ),
  );
  const reviews = decodeArrayOrNull(
    ReviewCodec,
    await fetchJsonlRows(ghApi, `repos/${input.repo}/pulls/${String(prNumber)}/reviews`, REVIEW_JQ),
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
    diffSize: Buffer.byteLength(diff, "utf8"),
  };
};
