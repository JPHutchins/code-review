// A native check-run on the PR head SHA is the attribution surface #115 asks for: it shows in the
// PR's own checks list, correlates by construction (it IS on the SHA), and — because the review runs
// from the base repo's default branch with a write token — works for fork PRs too, whose head commit
// is reachable in the base repo via the PR ref. The in-progress check is created at review start (the
// announce job, in its own concurrency group) so it survives a superseding run's cancellation. A
// completed review finalizes it `neutral` (non-gating); a hard-failed review finalizes it `failure`;
// a cancelled review leaves its in-progress check intact, so the superseding run that took over keeps
// the SHA attributed rather than a false failure being stamped on it.

import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
import { parseJsonl } from "./transcript.js";

export const CHECK_RUN_NAME = "Code review";

export type CheckIntent = "in_progress" | "neutral" | "failure";

export interface ExistingCheck {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string | null;
}

// Forward-only across the two writers (comment finalizes `neutral`, attribute_failure finalizes
// `failure`) that can race on a same-SHA re-run: a completed review is the truth, so `failure` never
// overwrites a completed `neutral`/`success`, and `in_progress` never re-opens a finished check.
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

const latest = (checks: readonly ExistingCheck[]): ExistingCheck | null =>
  checks.reduce<ExistingCheck | null>(
    (best, c) => (best === null || c.id > best.id ? c : best),
    null,
  );

const isOpen = (status: string): boolean => status === "in_progress" || status === "queued";
const settled = new Set(["success", "neutral", "skipped"]);

export const decideCheckAction = (
  checks: readonly ExistingCheck[],
  intent: CheckIntent,
): CheckAction => {
  const head = latest(checks);
  switch (intent) {
    case "in_progress":
      return head !== null && isOpen(head.status)
        ? { kind: "noop", reason: "a check is already in progress for this head" }
        : { kind: "create", status: "in_progress" };
    case "neutral":
      if (head === null) return { kind: "create", status: "completed", conclusion: "neutral" };
      return head.status === "completed" && head.conclusion === "neutral"
        ? { kind: "noop", reason: "the check already records this completed review" }
        : { kind: "patch", id: head.id, status: "completed", conclusion: "neutral" };
    case "failure":
      if (head === null) return { kind: "create", status: "completed", conclusion: "failure" };
      if (head.status === "completed" && head.conclusion !== null && settled.has(head.conclusion))
        return { kind: "noop", reason: "a completed review already recorded this head" };
      return head.status === "completed" && head.conclusion === "failure"
        ? { kind: "noop", reason: "the check already records this failure" }
        : { kind: "patch", id: head.id, status: "completed", conclusion: "failure" };
  }
};

const CHECK_JQ = ".check_runs[] | {id: .id, status: .status, conclusion: .conclusion}";

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
  }
};

export interface CheckRunInput {
  readonly repo: string;
  readonly headSha: string;
  readonly intent: CheckIntent;
  readonly runUrl: string;
}

// Resolve the current check, decide the forward-only action, then apply it. Head SHA (not the PR) is
// the whole key — no PR resolution needed, which is why this also works for fork PRs.
export const checkRun = async (input: CheckRunInput, ghApi: GhApi = runGhApi): Promise<void> => {
  const action = decideCheckAction(
    await fetchChecks(input.repo, input.headSha, ghApi),
    input.intent,
  );
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
