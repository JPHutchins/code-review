import { describe, it, expect } from "vitest";
import type { GhApi } from "./gh.js";
import { resolveCiRun, awaitCiConclusion, renderCiOutputs } from "./ci.js";

interface RunJson {
  readonly id: number;
  readonly name: string | null;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly run_number: number;
}

const runsJson = (runs: readonly RunJson[]): string => JSON.stringify({ workflow_runs: runs });

// A GhApi that returns a queued sequence of responses, one per call, in order.
const mkSeqGhApi = (responses: readonly (string | Error)[]): GhApi => {
  let i = 0;
  return () => {
    const r = responses[i++];
    if (r === undefined) return Promise.reject(new Error(`unexpected gh api call #${String(i)}`));
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
};

// sleep advances a virtual clock so elapsedMs() reflects wall spent polling — no real timers.
const mkClock = (): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly elapsedMs: () => number;
} => {
  let now = 0;
  return {
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    elapsedMs: () => now,
  };
};

const run = (over: Partial<RunJson> & Pick<RunJson, "run_number">): RunJson => ({
  id: over.run_number,
  name: "CI",
  status: "completed",
  conclusion: "success",
  ...over,
});

describe("resolveCiRun", () => {
  const api = (runs: readonly RunJson[]): GhApi => mkSeqGhApi([runsJson(runs)]);

  it("returns null when no run matches the workflow name", async () => {
    const got = await resolveCiRun("o/r", "sha", "CI", api([run({ run_number: 1, name: "Lint" })]));
    expect(got).toBeNull();
  });

  it("returns null when there are no runs at all (CI has not queued yet)", async () => {
    expect(await resolveCiRun("o/r", "sha", "CI", api([]))).toBeNull();
  });

  it("filters by workflow name and picks the highest run_number (a re-run wins)", async () => {
    const got = await resolveCiRun(
      "o/r",
      "sha",
      "CI",
      api([
        run({ run_number: 1, conclusion: "failure" }),
        run({ run_number: 3, conclusion: "success" }),
        run({ run_number: 2, name: "Lint", conclusion: "failure" }),
      ]),
    );
    expect(got).toEqual({ id: 3, status: "completed", conclusion: "success" });
  });

  it("throws on a malformed runs payload", async () => {
    await expect(resolveCiRun("o/r", "sha", "CI", mkSeqGhApi(['{"nope":1}']))).rejects.toThrow(
      /did not match/,
    );
  });
});

describe("awaitCiConclusion", () => {
  const OPTS = { workflowName: "CI", pollIntervalMs: 1000, timeoutMs: 10_000 };

  it("returns immediately when the run is already completed", async () => {
    const clock = mkClock();
    const got = await awaitCiConclusion("o/r", "sha", OPTS, {
      ghApi: mkSeqGhApi([runsJson([run({ run_number: 5, conclusion: "failure" })])]),
      ...clock,
    });
    expect(got).toEqual({ kind: "concluded", conclusion: "failure", runId: 5 });
    expect(clock.elapsedMs()).toBe(0);
  });

  it("polls past in_progress states until the run completes", async () => {
    const clock = mkClock();
    const got = await awaitCiConclusion("o/r", "sha", OPTS, {
      ghApi: mkSeqGhApi([
        runsJson([run({ run_number: 1, status: "in_progress", conclusion: null })]),
        runsJson([run({ run_number: 1, status: "in_progress", conclusion: null })]),
        runsJson([run({ run_number: 1, status: "completed", conclusion: "success" })]),
      ]),
      ...clock,
    });
    expect(got).toEqual({ kind: "concluded", conclusion: "success", runId: 1 });
    expect(clock.elapsedMs()).toBe(2000);
  });

  it("waits for a run that has not appeared yet, then concludes on it", async () => {
    const clock = mkClock();
    const got = await awaitCiConclusion("o/r", "sha", OPTS, {
      ghApi: mkSeqGhApi([
        runsJson([]),
        runsJson([run({ run_number: 2, status: "queued", conclusion: null })]),
        runsJson([run({ run_number: 2, status: "completed", conclusion: "success" })]),
      ]),
      ...clock,
    });
    expect(got).toEqual({ kind: "concluded", conclusion: "success", runId: 2 });
  });

  it("times out when the run never completes, reporting the last-seen run id", async () => {
    const clock = mkClock();
    const inProgress = runsJson([run({ run_number: 9, status: "in_progress", conclusion: null })]);
    const got = await awaitCiConclusion(
      "o/r",
      "sha",
      { ...OPTS, timeoutMs: 3000 },
      { ghApi: mkSeqGhApi([inProgress, inProgress, inProgress, inProgress]), ...clock },
    );
    expect(got).toEqual({ kind: "timed-out", runId: 9 });
  });

  it("times out with a null run id when CI never even appeared", async () => {
    const clock = mkClock();
    const got = await awaitCiConclusion(
      "o/r",
      "sha",
      { ...OPTS, timeoutMs: 2000 },
      { ghApi: mkSeqGhApi([runsJson([]), runsJson([]), runsJson([])]), ...clock },
    );
    expect(got).toEqual({ kind: "timed-out", runId: null });
  });

  it('maps a completed run with a null conclusion to "unknown"', async () => {
    const clock = mkClock();
    const got = await awaitCiConclusion("o/r", "sha", OPTS, {
      ghApi: mkSeqGhApi([
        runsJson([run({ run_number: 1, status: "completed", conclusion: null })]),
      ]),
      ...clock,
    });
    expect(got).toEqual({ kind: "concluded", conclusion: "unknown", runId: 1 });
  });
});

describe("renderCiOutputs", () => {
  it("emits ci_settled=true + conclusion + run id when concluded", () => {
    expect(renderCiOutputs({ kind: "concluded", conclusion: "failure", runId: 7 })).toBe(
      "ci_settled=true\nci_conclusion=failure\nci_run_id=7\n",
    );
  });

  it("emits ci_settled=false + the last-seen run id when timed out", () => {
    expect(renderCiOutputs({ kind: "timed-out", runId: 4 })).toBe(
      "ci_settled=false\nci_run_id=4\n",
    );
  });

  it("emits an empty ci_run_id when no run was ever seen", () => {
    expect(renderCiOutputs({ kind: "timed-out", runId: null })).toBe(
      "ci_settled=false\nci_run_id=\n",
    );
  });
});
