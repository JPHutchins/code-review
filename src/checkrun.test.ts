import { describe, it, expect } from "vitest";
import {
  checkRun,
  decideCheckAction,
  decideCancelledAction,
  runIdFromUrl,
  type ExistingCheck,
} from "./checkrun.js";

const open = (id: number, runId: string | null): ExistingCheck => ({
  id,
  status: "in_progress",
  conclusion: null,
  detailsUrl: runId === null ? null : `https://github.com/o/r/actions/runs/${runId}`,
});
const done = (id: number, runId: string | null, conclusion: string): ExistingCheck => ({
  id,
  status: "completed",
  conclusion,
  detailsUrl: runId === null ? null : `https://github.com/o/r/actions/runs/${runId}`,
});

const ownedOpen = open(1, "123");
const ownedNeutral = done(2, "123", "neutral");
const ownedFailure = done(3, "123", "failure");
const ownedCancelled = done(4, "123", "cancelled");
const successorOpen = open(5, "1234");
const noRunUrl = "https://github.com/o/r";

describe("decideCheckAction", () => {
  it("in_progress: opens a fresh check per run and is idempotent for the SAME run (issue #139)", () => {
    // No check for this run → create (even if another run's check exists on the head).
    expect(
      decideCheckAction([successorOpen], "in_progress", "https://github.com/o/r/actions/runs/123"),
    ).toEqual({ kind: "create", status: "in_progress" });
    // This run's announce already opened its own check → noop (idempotent announce retry).
    expect(
      decideCheckAction([ownedOpen], "in_progress", "https://github.com/o/r/actions/runs/123").kind,
    ).toBe("noop");
  });

  it("neutral: settles THIS run's check, never a newer run's live check", () => {
    // This run owns check 1; a successor owns check 5. Neutral must patch check 1, not the latest.
    expect(
      decideCheckAction(
        [ownedOpen, successorOpen],
        "neutral",
        "https://github.com/o/r/actions/runs/123",
      ),
    ).toEqual({ kind: "patch", id: 1, status: "completed", conclusion: "neutral" });
  });

  it("neutral: creates when this run has no check, and is idempotent once recorded", () => {
    expect(decideCheckAction([], "neutral", "https://github.com/o/r/actions/runs/123")).toEqual({
      kind: "create",
      status: "completed",
      conclusion: "neutral",
    });
    expect(
      decideCheckAction([ownedNeutral], "neutral", "https://github.com/o/r/actions/runs/123").kind,
    ).toBe("noop");
  });

  it("failure: settles THIS run's check with the forward-only guard", () => {
    expect(
      decideCheckAction(
        [ownedOpen, successorOpen],
        "failure",
        "https://github.com/o/r/actions/runs/123",
      ),
    ).toEqual({ kind: "patch", id: 1, status: "completed", conclusion: "failure" });
    // Never overwrite a completed review (this run's check already neutral).
    expect(
      decideCheckAction([ownedNeutral], "failure", "https://github.com/o/r/actions/runs/123").kind,
    ).toBe("noop");
    // Idempotent once recorded.
    expect(
      decideCheckAction([ownedFailure], "failure", "https://github.com/o/r/actions/runs/123").kind,
    ).toBe("noop");
  });

  it("creates when the run URL carries no run id (no owned check to settle)", () => {
    expect(decideCheckAction([successorOpen], "neutral", noRunUrl)).toEqual({
      kind: "create",
      status: "completed",
      conclusion: "neutral",
    });
    expect(decideCheckAction([], "in_progress", noRunUrl)).toEqual({
      kind: "create",
      status: "in_progress",
    });
  });
});

describe("runIdFromUrl", () => {
  it("extracts the run id from the actions/runs URL", () => {
    expect(runIdFromUrl("https://github.com/o/r/actions/runs/123")).toBe("123");
    expect(runIdFromUrl("https://github.com/o/r/actions/runs/123/")).toBe("123");
    expect(runIdFromUrl("https://github.com/o/r/actions/runs/1234")).toBe("1234");
  });

  it("returns null for a URL that carries no run id", () => {
    expect(runIdFromUrl("")).toBeNull();
    expect(runIdFromUrl("https://github.com/o/r")).toBeNull();
    expect(runIdFromUrl("https://github.com/o/r/actions/runs/")).toBeNull();
  });
});

describe("decideCancelledAction — issue #139", () => {
  it("settles ONLY the check this run's announce created (matched by details_url run id)", () => {
    // A successor run (1234) has already opened a NEWER in-progress check on the same head; the
    // cancelled run (123) must settle its own check, never the live successor.
    expect(
      decideCancelledAction([successorOpen, ownedOpen], "https://github.com/o/r/actions/runs/123"),
    ).toEqual({
      kind: "patch",
      id: 1,
      status: "completed",
      conclusion: "cancelled",
    });
  });

  it("is idempotent once the owned check already records cancelled", () => {
    expect(
      decideCancelledAction([ownedCancelled], "https://github.com/o/r/actions/runs/123").kind,
    ).toBe("noop");
  });

  it("no-ops when this run created no check (e.g. the announce never ran)", () => {
    expect(
      decideCancelledAction([successorOpen], "https://github.com/o/r/actions/runs/123").kind,
    ).toBe("noop");
    expect(decideCancelledAction([], "https://github.com/o/r/actions/runs/123").kind).toBe("noop");
  });

  it("never overwrites a completed review's settled check (forward-only, like failure)", () => {
    expect(
      decideCancelledAction([ownedNeutral], "https://github.com/o/r/actions/runs/123").kind,
    ).toBe("noop");
  });

  it("does not match a successor whose run id has this run's id as a numeric prefix", () => {
    // Run 123 must NOT settle run 1234's check (123 is a prefix of 1234).
    expect(
      decideCancelledAction([successorOpen], "https://github.com/o/r/actions/runs/123").kind,
    ).toBe("noop");
  });
});

describe("checkRun", () => {
  const capture = () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const ghApi = (args: readonly string[], stdin?: string): Promise<string> => {
      calls.push({ args, stdin });
      if (args[0]?.includes("/check-runs?check_name=")) return Promise.resolve("");
      return Promise.resolve("{}");
    };
    return { calls, ghApi };
  };

  it("POSTs a new in_progress check on the head sha when none exists", async () => {
    const { calls, ghApi } = capture();
    await checkRun({ repo: "o/r", headSha: "abc", intent: "in_progress", runUrl: "u" }, ghApi);
    const write = calls.find((c) => c.args.includes("POST"));
    expect(write?.args).toContain("repos/o/r/check-runs");
    const body = JSON.parse(write?.stdin ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Code review", head_sha: "abc", status: "in_progress" });
  });

  it("makes no write call when the decision is a no-op (already-neutral owned check)", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const ghApi = (args: readonly string[]): Promise<string> => {
      calls.push({ args });
      // The mock returns the POST-jq shape: the JQ maps details_url → detailsUrl (camelCase).
      return Promise.resolve(
        '{"id":1,"status":"completed","conclusion":"neutral","detailsUrl":"https://g/actions/runs/123"}',
      );
    };
    await checkRun(
      { repo: "o/r", headSha: "abc", intent: "neutral", runUrl: "https://g/actions/runs/123" },
      ghApi,
    );
    expect(calls.some((c) => c.args.includes("POST") || c.args.includes("PATCH"))).toBe(false);
  });

  it("makes no write call when a cancelled run owns no check", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const ghApi = (args: readonly string[]): Promise<string> => {
      calls.push({ args });
      return Promise.resolve(""); // jq emits no lines when there are no check-runs
    };
    await checkRun(
      { repo: "o/r", headSha: "abc", intent: "cancelled", runUrl: "https://g/actions/runs/123" },
      ghApi,
    );
    expect(calls.some((c) => c.args.includes("POST") || c.args.includes("PATCH"))).toBe(false);
  });
});
