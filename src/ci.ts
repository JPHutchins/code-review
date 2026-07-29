// Resolves and waits for a PR head's CI workflow run, so the on-demand comment trigger routes on the
// SAME real CI conclusion the workflow_run trigger would: success → full review, failure → mechanic
// with that run's failing-job logs. Without this the comment path reviews blind to CI — throwing away
// the differentiator. The head SHA is trusted (resolved from the PR number via the API), so it is
// safe in the query; the workflow name is trusted caller config.

import { performance } from "node:perf_hooks";
import * as t from "io-ts";
import { PathReporter } from "io-ts/lib/PathReporter.js";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
import { parseJsonl } from "./transcript.js";
import { errMsg } from "./util.js";

const RunCodec = t.type({
  id: t.number,
  name: t.union([t.string, t.null]),
  status: t.union([t.string, t.null]),
  conclusion: t.union([t.string, t.null]),
  run_number: t.number,
});

export interface CiRun {
  readonly id: number;
  // queued | in_progress | requested | waiting | pending | completed
  readonly status: string;
  // success | failure | cancelled | timed_out | ... — null until status is completed
  readonly conclusion: string | null;
}

export interface CiLookup {
  // The matched run, or null if the named workflow has no run for this head SHA yet.
  readonly run: CiRun | null;
  // Distinct workflow names that DID run for this head SHA — lets a caller tell a mistyped
  // workflowName (which otherwise just times out) from "the named CI simply has not queued yet".
  readonly seenNames: readonly string[];
}

// One projected run object per row across ALL pages: `--paginate` WITHOUT `--jq` concatenates each
// page's `{workflow_runs: […]}` object into a stream JSON.parse rejects, so only the first page (≤100
// runs) was ever read — a head SHA with many workflows or re-runs could push the awaited run out of
// view and the comment path would decline with no diagnostic. `--jq` unwraps `.workflow_runs[]` and
// streams NDJSON parseJsonl reads line by line, the shape gather/post already use.
const RUN_JQ =
  ".workflow_runs[] | {id: .id, name: .name, status: .status, conclusion: .conclusion, run_number: .run_number}";

// The latest run of the named CI workflow for this head SHA. NOT filtered by triggering event: CI may
// run on `push` as well as `pull_request`, and the head SHA already pins the commit. Latest = highest
// run_number, so a re-run supersedes. `run` is null when the named workflow has no run yet (the
// comment may fire before CI even queues). A row that doesn't match the run shape is dropped rather
// than aborting the lookup — an empty result then reads as "not queued yet" and the caller declines.
export const resolveCiRun = async (
  repo: string,
  headSha: string,
  workflowName: string,
  ghApi: GhApi,
): Promise<CiLookup> => {
  const endpoint = `repos/${repo}/actions/runs?head_sha=${headSha}&per_page=100`;
  const rows = parseJsonl(await ghApi([endpoint, "--paginate", "--jq", RUN_JQ]));
  const decoded = rows.map((row) => RunCodec.decode(row));
  const runs = decoded.flatMap((d) => (d._tag === "Right" ? [d.right] : []));
  // A row that fails the codec is dropped rather than aborting the lookup, but a drop is never normal:
  // a partial drift can silently drop the newest run and route on a stale one, and a total drift reads
  // as an empty result that declines only after a full timeout. So name every drop, with the first
  // failure's field-level detail, so the drifted field is diagnosable without reproducing the call.
  const dropped = decoded.length - runs.length;
  if (dropped > 0) {
    const firstDrift = decoded.find((d) => d._tag === "Left");
    const detail =
      firstDrift === undefined ? "" : ` (${PathReporter.report(firstDrift).join("; ")})`;
    process.stderr.write(
      `Warning: ${String(dropped)} of ${String(rows.length)} workflow-run row(s) from ${endpoint} failed to decode${detail} — excluded from the lookup\n`,
    );
  }
  const latest = runs
    .filter((r) => r.name === workflowName)
    .reduce<t.TypeOf<typeof RunCodec> | null>(
      (best, r) => (best === null || r.run_number > best.run_number ? r : best),
      null,
    );
  return {
    run:
      latest === null
        ? null
        : { id: latest.id, status: latest.status ?? "unknown", conclusion: latest.conclusion },
    seenNames: [...new Set(runs.flatMap((r) => (r.name === null ? [] : [r.name])))],
  };
};

export type CiOutcome =
  | { readonly kind: "concluded"; readonly conclusion: string; readonly runId: number }
  // No conclusive CI result within the timeout — the run never appeared or never completed. The
  // caller declines to review rather than fabricate a conclusion. seenNames carries the workflow
  // names that DID run, so a mistyped ci_workflow can be diagnosed instead of silently timing out.
  | {
      readonly kind: "timed-out";
      readonly runId: number | null;
      readonly seenNames: readonly string[];
    };

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
  // `--paginate` fetches one page per HTTP request, so a transient blip on any page rejects the whole
  // lookup. Contain it to a diagnostic + empty result rather than let it unwind and abort the wait:
  // the loop is meant to be resilient, so a failed poll should retry until the run settles or the
  // timeout declines, never crash mid-wait.
  const safeResolve = async (): Promise<CiLookup> => {
    try {
      return await resolveCiRun(repo, headSha, options.workflowName, deps.ghApi);
    } catch (err) {
      process.stderr.write(
        `Warning: CI-run lookup for ${headSha} failed (${errMsg(err)}) — retrying until the timeout\n`,
      );
      return { run: null, seenNames: [] };
    }
  };
  const poll = async (
    lastSeenNames: readonly string[],
    lastRunId: number | null,
  ): Promise<CiOutcome> => {
    const { run, seenNames } = await safeResolve();
    // A run momentarily reports `completed` with a null conclusion before GitHub settles it; treating
    // that as concluded would fabricate a routing decision, so keep polling until the conclusion lands
    // (or the timeout declines) rather than collapsing it to a made-up "unknown" the caller can act on.
    if (run !== null && run.status === "completed" && run.conclusion !== null)
      return { kind: "concluded", conclusion: run.conclusion, runId: run.id };
    // A caught error zeroes this poll's view, so carry the last non-empty observation forward — else a
    // transient failure on the very iteration that times out would erase the run id and workflow names
    // earlier polls saw, misleading the mistyped-workflow-vs-not-queued-yet diagnostic renderCiOutputs
    // depends on.
    const runId = run === null ? lastRunId : run.id;
    const names = seenNames.length > 0 ? seenNames : lastSeenNames;
    if (deps.elapsedMs() >= options.timeoutMs)
      return { kind: "timed-out", runId, seenNames: names };
    await deps.sleep(options.pollIntervalMs);
    return poll(names, runId);
  };
  return poll([], null);
};

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// performance.now() is monotonic — unlike Date.now(), an NTP/VM wall-clock step back mid-poll can't
// make elapsedMs() decrease and stall the timeout check the loop depends on.
export const monotonicElapsed = (): (() => number) => {
  const start = performance.now();
  return () => performance.now() - start;
};

// ci_settled distinguishes "we know the CI result" from "we gave up waiting" so the gate can decline
// the review on a non-settle rather than run it on a guessed conclusion.
export const renderCiOutputs = (outcome: CiOutcome): string =>
  outcome.kind === "concluded"
    ? `ci_settled=true\nci_conclusion=${outcome.conclusion}\nci_run_id=${String(outcome.runId)}\n`
    : `ci_settled=false\nci_run_id=${outcome.runId === null ? "" : String(outcome.runId)}\n`;
