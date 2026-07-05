// Gather review inputs (SPEC §8.2): resolve the PR from the trusted head SHA, fetch the diff (with
// a non-truncating git-diff fallback), the PR context, the prior bot review, and — when CI
// failed — the failing-job logs. Mirrors the bash "Gather review inputs" step 1:1, but as
// vitest-tested TypeScript, sharing `post`'s PR resolution so the two jobs never split-brain.

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as t from "io-ts";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
import { fetchDiff, fetchPrCandidates, resolvePr } from "./pr.js";

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

/** The GitHub-outputs lines the step appends to $GITHUB_OUTPUT. CI-agnostic + directly testable. */
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

const IssueCommentCodec = t.type({
  id: t.number,
  body: t.union([t.string, t.null]),
  user: t.type({ login: t.string }),
});
const IssueCommentsCodec = t.array(IssueCommentCodec);

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

/** Fetch the diff via the API; null on failure (drives the git fallback). */
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

/** Last comment authored by botLogin, or null. Degrades to null on ANY failure (bash `|| echo null`). */
const fetchPriorReview = async (
  repo: string,
  prNumber: number,
  botLogin: string,
  ghApi: GhApi,
): Promise<{ readonly id: number; readonly body: string | null } | null> => {
  try {
    const stdout = await ghApi([`repos/${repo}/issues/${String(prNumber)}/comments`, "--paginate"]);
    const decoded = IssueCommentsCodec.decode(JSON.parse(stdout || "[]") as unknown);
    if (decoded._tag === "Left") return null;
    const byBot = decoded.right.filter((c) => c.user.login === botLogin);
    const last = byBot[byBot.length - 1];
    return last ? { id: last.id, body: last.body } : null;
  } catch {
    return null;
  }
};

/** Download each failing job's logs → <outDir>/job_<id>.log. Jobs-list failure is fatal; a
 *  per-log download failure degrades (warns to stderr, keeps whatever logs were retrieved) —
 *  logs are advisory input, and partial logs plus the diff beat a dead review. */
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
        `Warning: failed to download logs for job ${String(job.id)}: ${err instanceof Error ? err.message : String(err)} — continuing with the logs retrieved so far\n`,
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

  const prior = await fetchPriorReview(input.repo, prNumber, input.botLogin, ghApi);
  writeFileSync(
    join(input.outDir, "prior_review.json"),
    prior === null ? "null" : JSON.stringify(prior),
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
