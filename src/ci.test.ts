import { describe, it, expect, vi } from "vitest";
import type { GhApi } from "./gh.js";
import { resolveCiRun, awaitCiConclusion, renderCiOutputs } from "./ci.js";

interface RunJson {
  readonly id: number;
  readonly name: string | null;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly run_number: number;
}

// resolveCiRun now fetches with `--jq RUN_JQ`, so gh's stdout is one projected run per line (NDJSON),
// the shape parseJsonl reads — the mock stands in for that already-projected, page-concatenated stream.
const runsJson = (runs: readonly RunJson[]): string =>
  runs.map((r) => JSON.stringify(r)).join("\n");

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

  it("returns run=null but reports the seen names when none matches the workflow name", async () => {
    const got = await resolveCiRun("o/r", "sha", "CI", api([run({ run_number: 1, name: "Lint" })]));
    expect(got.run).toBeNull();
    expect(got.seenNames).toEqual(["Lint"]);
  });

  it("returns run=null and no seen names when there are no runs at all (CI not queued yet)", async () => {
    const got = await resolveCiRun("o/r", "sha", "CI", api([]));
    expect(got.run).toBeNull();
    expect(got.seenNames).toEqual([]);
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
    expect(got.run).toEqual({ id: 3, status: "completed", conclusion: "success" });
    expect(got.seenNames).toEqual(["CI", "Lint"]);
  });

  it("matches a push-triggered run (event is not filtered)", async () => {
    const got = await resolveCiRun(
      "o/r",
      "sha",
      "CI",
      api([run({ run_number: 7, status: "completed", conclusion: "success" })]),
    );
    expect(got.run).toEqual({ id: 7, status: "completed", conclusion: "success" });
  });

  it("drops an invalid row but keeps the valid ones, with no false format-drift warning", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const got = await resolveCiRun(
        "o/r",
        "sha",
        "CI",
        mkSeqGhApi([
          `{"nope":1}\n${JSON.stringify(run({ run_number: 4, conclusion: "success" }))}`,
        ]),
      );
      expect(got.run).toEqual({ id: 4, status: "completed", conclusion: "success" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("warns and returns empty when every fetched row fails to decode (format drift)", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const got = await resolveCiRun("o/r", "sha", "CI", mkSeqGhApi(['{"nope":1}\n{"also":2}']));
      expect(got.run).toBeNull();
      expect(got.seenNames).toEqual([]);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("failed to decode"));
    } finally {
      spy.mockRestore();
    }
  });

  it("finds a matching run that only appears on a later page (paginated NDJSON)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      run({ run_number: i + 1, name: "Lint", conclusion: "success" }),
    );
    const got = await resolveCiRun(
      "o/r",
      "sha",
      "CI",
      api([...page1, run({ run_number: 101, name: "CI", conclusion: "failure" })]),
    );
    expect(got.run).toEqual({ id: 101, status: "completed", conclusion: "failure" });
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

  it("times out when the run never completes, reporting the last-seen run id + names", async () => {
    const clock = mkClock();
    const inProgress = runsJson([run({ run_number: 9, status: "in_progress", conclusion: null })]);
    const got = await awaitCiConclusion(
      "o/r",
      "sha",
      { ...OPTS, timeoutMs: 3000 },
      { ghApi: mkSeqGhApi([inProgress, inProgress, inProgress, inProgress]), ...clock },
    );
    expect(got).toEqual({ kind: "timed-out", runId: 9, seenNames: ["CI"] });
  });

  it("times out with a null run id + the mismatched names when the named CI never appeared", async () => {
    const clock = mkClock();
    const others = runsJson([
      run({ run_number: 1, name: "Lint", status: "in_progress", conclusion: null }),
    ]);
    const got = await awaitCiConclusion(
      "o/r",
      "sha",
      { ...OPTS, timeoutMs: 2000 },
      { ghApi: mkSeqGhApi([others, others, others]), ...clock },
    );
    expect(got).toEqual({ kind: "timed-out", runId: null, seenNames: ["Lint"] });
  });

  it("does not treat a completed run with a null conclusion as concluded — keeps polling until it settles", async () => {
    const clock = mkClock();
    const got = await awaitCiConclusion("o/r", "sha", OPTS, {
      ghApi: mkSeqGhApi([
        runsJson([run({ run_number: 1, status: "completed", conclusion: null })]),
        runsJson([run({ run_number: 1, status: "completed", conclusion: "success" })]),
      ]),
      ...clock,
    });
    expect(got).toEqual({ kind: "concluded", conclusion: "success", runId: 1 });
    expect(clock.elapsedMs()).toBe(1000);
  });

  it("times out (declines) when a run stays completed with a null conclusion", async () => {
    const clock = mkClock();
    const nullConcl = runsJson([run({ run_number: 3, status: "completed", conclusion: null })]);
    const got = await awaitCiConclusion(
      "o/r",
      "sha",
      { ...OPTS, timeoutMs: 2000 },
      { ghApi: mkSeqGhApi([nullConcl, nullConcl, nullConcl]), ...clock },
    );
    expect(got).toEqual({ kind: "timed-out", runId: 3, seenNames: ["CI"] });
  });

  it("retries past a transient lookup failure rather than crashing the poll loop", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const clock = mkClock();
    try {
      const got = await awaitCiConclusion("o/r", "sha", OPTS, {
        ghApi: mkSeqGhApi([
          runsJson([run({ run_number: 1, status: "in_progress", conclusion: null })]),
          new Error("gh: transient 502 on page 2"),
          runsJson([run({ run_number: 1, status: "completed", conclusion: "success" })]),
        ]),
        ...clock,
      });
      expect(got).toEqual({ kind: "concluded", conclusion: "success", runId: 1 });
      expect(clock.elapsedMs()).toBe(2000);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("retrying until the timeout"));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("renderCiOutputs", () => {
  it("emits ci_settled=true + conclusion + run id when concluded", () => {
    expect(renderCiOutputs({ kind: "concluded", conclusion: "failure", runId: 7 })).toBe(
      "ci_settled=true\nci_conclusion=failure\nci_run_id=7\n",
    );
  });

  it("emits ci_settled=false + the last-seen run id when timed out", () => {
    expect(renderCiOutputs({ kind: "timed-out", runId: 4, seenNames: ["CI"] })).toBe(
      "ci_settled=false\nci_run_id=4\n",
    );
  });

  it("emits an empty ci_run_id when no run was ever seen", () => {
    expect(renderCiOutputs({ kind: "timed-out", runId: null, seenNames: [] })).toBe(
      "ci_settled=false\nci_run_id=\n",
    );
  });
});
