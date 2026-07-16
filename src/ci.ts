// Resolves and waits for a PR head's CI workflow run, so the on-demand comment trigger routes on the
// SAME real CI conclusion the workflow_run trigger would: success → full review, failure → mechanic
// with that run's failing-job logs. Without this the comment path reviews blind to CI — throwing away
// the differentiator. The head SHA is trusted (resolved from the PR number via the API), so it is
// safe in the query; the workflow name is trusted caller config.

import * as t from "io-ts";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";

const RunCodec = t.type({
  id: t.number,
  name: t.union([t.string, t.null]),
  status: t.union([t.string, t.null]),
  conclusion: t.union([t.string, t.null]),
  run_number: t.number,
});
const RunsCodec = t.type({ workflow_runs: t.array(RunCodec) });

export interface CiRun {
  readonly id: number;
  // queued | in_progress | requested | waiting | pending | completed
  readonly status: string;
  // success | failure | cancelled | timed_out | ... — null until status is completed
  readonly conclusion: string | null;
}

// The latest run of the named CI workflow for this head SHA on a pull_request, or null if none exists
// yet (the comment may fire before CI even queues). Latest = highest run_number, so a re-run wins.
export const resolveCiRun = async (
  repo: string,
  headSha: string,
  workflowName: string,
  ghApi: GhApi,
): Promise<CiRun | null> => {
  const stdout = await ghApi([
    `repos/${repo}/actions/runs?head_sha=${headSha}&event=pull_request&per_page=100`,
  ]);
  const decoded = RunsCodec.decode(JSON.parse(stdout) as unknown);
  if (decoded._tag === "Left")
    throw new Error(`workflow runs for ${headSha} did not match the expected shape`);
  const latest = decoded.right.workflow_runs
    .filter((r) => r.name === workflowName)
    .reduce<t.TypeOf<typeof RunCodec> | null>(
      (best, r) => (best === null || r.run_number > best.run_number ? r : best),
      null,
    );
  return latest === null
    ? null
    : { id: latest.id, status: latest.status ?? "unknown", conclusion: latest.conclusion };
};

export type CiOutcome =
  | { readonly kind: "concluded"; readonly conclusion: string; readonly runId: number }
  // No conclusive CI result within the timeout — the run never appeared or never completed. The
  // caller declines to review rather than fabricate a conclusion.
  | { readonly kind: "timed-out"; readonly runId: number | null };

export interface AwaitOptions {
  readonly workflowName: string;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
}

export interface AwaitDeps {
  readonly ghApi: GhApi;
  readonly sleep: (ms: number) => Promise<void>;
  readonly elapsedMs: () => number;
}

export const awaitCiConclusion = async (
  repo: string,
  headSha: string,
  options: AwaitOptions,
  deps: AwaitDeps = { ghApi: runGhApi, sleep: defaultSleep, elapsedMs: monotonicElapsed() },
): Promise<CiOutcome> => {
  const poll = async (): Promise<CiOutcome> => {
    const run = await resolveCiRun(repo, headSha, options.workflowName, deps.ghApi);
    if (run !== null && run.status === "completed")
      return { kind: "concluded", conclusion: run.conclusion ?? "unknown", runId: run.id };
    if (deps.elapsedMs() >= options.timeoutMs)
      return { kind: "timed-out", runId: run === null ? null : run.id };
    await deps.sleep(options.pollIntervalMs);
    return poll();
  };
  return poll();
};

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export const monotonicElapsed = (): (() => number) => {
  const start = Date.now();
  return () => Date.now() - start;
};

// ci_settled distinguishes "we know the CI result" from "we gave up waiting" so the gate can decline
// the review on a non-settle rather than run it on a guessed conclusion.
export const renderCiOutputs = (outcome: CiOutcome): string =>
  outcome.kind === "concluded"
    ? `ci_settled=true\nci_conclusion=${outcome.conclusion}\nci_run_id=${String(outcome.runId)}\n`
    : `ci_settled=false\nci_run_id=${outcome.runId === null ? "" : String(outcome.runId)}\n`;
