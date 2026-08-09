// A native check-run on the PR head SHA is the attribution surface #115 asks for: it shows in the
// PR's own checks list, correlates by construction (it IS on the SHA), and — because the review runs
// from the base repo's default branch with a write token — works for fork PRs too, whose head commit
// is reachable in the base repo via the PR ref. The in-progress check is created at review start (the
// announce job, in its own concurrency group) so it survives a superseding run's cancellation. A
// completed review finalizes it `neutral` (non-gating); a hard-failed review finalizes it `failure`;
// a cancelled review finalizes its OWN check `cancelled` (issue #139). Every settlement is
// OWNERSHIP-AWARE: it targets the check whose details_url carries this run's id (the announce stamps
// `${server_url}/${repo}/actions/runs/<run_id>`), so a same-SHA supersede — where a newer run's
// announce has already opened its own in-progress check — never settles the wrong run's check.

import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
import { parseJsonl } from "./transcript.js";

export const CHECK_RUN_NAME = "Code review";

export type CheckIntent = "in_progress" | "neutral" | "failure" | "cancelled";

export interface ExistingCheck {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly detailsUrl: string | null;
}

// Forward-only across the writers (comment finalizes `neutral`, attribute_failure finalizes
// `failure`, the cancelled run settles `cancelled`) that can race on a same-SHA re-run: a completed
// review is the truth, so `failure`/`cancelled` never overwrite a completed `neutral`/`success`, and
// `in_progress` never re-opens a finished check.
export type CheckAction =
  | { readonly kind: "noop"; readonly reason: string }
  | {
      readonly kind: "create";
      readonly status: "in_progress" | "completed";
      readonly conclusion?: string;
    }
  | {
      readonly kind: "patch";
      readonly id: number;
      readonly status: "completed";
      readonly conclusion: string;
    };

const settled = new Set(["success", "neutral", "skipped"]);

// The run id the announce job stamps into the check's details_url (`.../actions/runs/<run_id>`), used
// to attribute a check to the run that created it. null when the URL doesn't carry one.
export const runIdFromUrl = (runUrl: string): string | null => {
  const m = /\/actions\/runs\/(\d+)\/?$/.exec(runUrl);
  return m?.[1] ?? null;
};

// The check THIS run's announce created — the one whose details_url ends with `/runs/<this run id>`.
// Matching the numeric run id (not a substring of the whole URL) keeps a successor whose run id has
// this one as a numeric prefix from being matched.
const ownedCheck = (checks: readonly ExistingCheck[], runUrl: string): ExistingCheck | null => {
  const runId = runIdFromUrl(runUrl);
  if (runId === null) return null;
  return (
    checks.find((c) => c.detailsUrl !== null && c.detailsUrl.endsWith(`/runs/${runId}`)) ?? null
  );
};

export const decideCheckAction = (
  checks: readonly ExistingCheck[],
  intent: CheckIntent,
  runUrl: string,
): CheckAction => {
  const owned = ownedCheck(checks, runUrl);
  switch (intent) {
    case "in_progress":
      // Per-run idempotent: each run opens exactly ONE check (announce retries no-op once its own
      // exists), so a same-SHA supersede never shares a check with the superseded run.
      return owned !== null
        ? { kind: "noop", reason: "this run's check is already in progress" }
        : { kind: "create", status: "in_progress" };
    case "neutral":
      if (owned === null) return { kind: "create", status: "completed", conclusion: "neutral" };
      return owned.status === "completed" && owned.conclusion === "neutral"
        ? { kind: "noop", reason: "the check already records this completed review" }
        : { kind: "patch", id: owned.id, status: "completed", conclusion: "neutral" };
    case "failure":
      if (owned === null) return { kind: "create", status: "completed", conclusion: "failure" };
      if (
        owned.status === "completed" &&
        owned.conclusion !== null &&
        settled.has(owned.conclusion)
      )
        return { kind: "noop", reason: "a completed review already recorded this head" };
      return owned.status === "completed" && owned.conclusion === "failure"
        ? { kind: "noop", reason: "the check already records this failure" }
        : { kind: "patch", id: owned.id, status: "completed", conclusion: "failure" };
    case "cancelled":
      // Never reached via decideCheckAction — `cancelled` needs the runUrl and is dispatched to
      // decideCancelledAction by checkRun.
      return { kind: "noop", reason: "cancelled is handled via decideCancelledAction" };
  }
};

// Settle ONLY the check this run's announce created — matched by its details_url carrying this run's
// id. Ownership-aware: on a concurrency-cancelled review the superseding run's announce has already
// opened a NEWER in-progress check on the same head, and settling that one would falsely mark a live
// review cancelled. Matching the numeric run id (not a substring of the whole URL) also keeps a
// successor whose run id has this one as a numeric prefix from being matched.
export const decideCancelledAction = (
  checks: readonly ExistingCheck[],
  runUrl: string,
): CheckAction => {
  const owned = ownedCheck(checks, runUrl);
  if (owned === null) return { kind: "noop", reason: "no check was created by this run to settle" };
  if (owned.status === "completed" && owned.conclusion === "cancelled")
    return { kind: "noop", reason: "the check already records this cancelled run" };
  // Forward-only like `failure`: never overwrite a completed review's settled check with cancelled.
  if (owned.status === "completed" && owned.conclusion !== null && settled.has(owned.conclusion))
    return { kind: "noop", reason: "a completed review already recorded this head" };
  return { kind: "patch", id: owned.id, status: "completed", conclusion: "cancelled" };
};

const CHECK_JQ =
  ".check_runs[] | {id: .id, status: .status, conclusion: .conclusion, detailsUrl: .details_url}";

const fetchChecks = async (
  repo: string,
  headSha: string,
  ghApi: GhApi,
): Promise<readonly ExistingCheck[]> =>
  parseJsonl(
    await ghApi([
      `repos/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(CHECK_RUN_NAME)}&per_page=100`,
      "--paginate",
      "--jq",
      CHECK_JQ,
    ]),
  ) as readonly ExistingCheck[];

const output = (intent: CheckIntent, runUrl: string): { title: string; summary: string } => {
  switch (intent) {
    case "in_progress":
      return {
        title: "Code review in progress",
        summary: `The review is running — [see the run](${runUrl}).`,
      };
    case "neutral":
      return {
        title: "Code review complete",
        summary: `The review was posted — [see the run](${runUrl}).`,
      };
    case "failure":
      return {
        title: "Code review did not complete",
        summary: `The review job failed — [see the run](${runUrl}). Re-request the review; do not treat this round as spent.`,
      };
    case "cancelled":
      return {
        title: "Code review superseded",
        summary: `This review run was cancelled — [see the run](${runUrl}). No action needed.`,
      };
  }
};

export interface CheckRunInput {
  readonly repo: string;
  readonly headSha: string;
  readonly intent: CheckIntent;
  readonly runUrl: string;
}

// Resolve the current check, decide the forward-only ownership-aware action, then apply it. Head SHA
// (not the PR) is the whole key — no PR resolution needed, which is why this also works for fork PRs.
export const checkRun = async (input: CheckRunInput, ghApi: GhApi = runGhApi): Promise<void> => {
  const checks = await fetchChecks(input.repo, input.headSha, ghApi);
  const action =
    input.intent === "cancelled"
      ? decideCancelledAction(checks, input.runUrl)
      : decideCheckAction(checks, input.intent, input.runUrl);
  if (action.kind === "noop") {
    process.stderr.write(`code-review check-run: ${action.reason} — leaving it\n`);
    return;
  }
  const body =
    action.kind === "create"
      ? {
          name: CHECK_RUN_NAME,
          head_sha: input.headSha,
          status: action.status,
          details_url: input.runUrl,
          ...(action.conclusion ? { conclusion: action.conclusion } : {}),
          output: output(input.intent, input.runUrl),
        }
      : {
          status: action.status,
          conclusion: action.conclusion,
          details_url: input.runUrl,
          output: output(input.intent, input.runUrl),
        };
  const endpoint =
    action.kind === "create"
      ? [`--method`, `POST`, `repos/${input.repo}/check-runs`, `--input`, `-`]
      : [
          `--method`,
          `PATCH`,
          `repos/${input.repo}/check-runs/${String(action.id)}`,
          `--input`,
          `-`,
        ];
  await ghApi(endpoint, JSON.stringify(body));
};
