import { describe, it, expect } from "vitest";
import {
  checkRun,
  decideCheckAction,
  decideCancelledAction,
  runIdFromUrl,
  type ExistingCheck,
} from "./checkrun.js";

const open: ExistingCheck = { id: 1, status: "in_progress", conclusion: null, detailsUrl: null };
const doneNeutral: ExistingCheck = {
  id: 2,
  status: "completed",
  conclusion: "neutral",
  detailsUrl: null,
};
const doneFailure: ExistingCheck = {
  id: 3,
  status: "completed",
  conclusion: "failure",
  detailsUrl: null,
};
const ownedOpen: ExistingCheck = {
  id: 4,
  status: "in_progress",
  conclusion: null,
  detailsUrl: "https://github.com/o/r/actions/runs/123",
};
const successorOpen: ExistingCheck = {
  id: 5,
  status: "in_progress",
  conclusion: null,
  detailsUrl: "https://github.com/o/r/actions/runs/1234",
};
const ownedCancelled: ExistingCheck = {
  id: 6,
  status: "completed",
  conclusion: "cancelled",
  detailsUrl: "https://github.com/o/r/actions/runs/123",
};

describe("decideCheckAction", () => {
  it("in_progress ALWAYS creates a fresh check — per-run ownership (issue #139 r5)", () => {
    // A same-SHA supersede must not share the superseded run's check: each run owns its own, so the
    // cancelled run settles its own (by details_url) and the superseding run finalizes its own.
    expect(decideCheckAction([], "in_progress")).toEqual({ kind: "create", status: "in_progress" });
    expect(decideCheckAction([open], "in_progress")).toEqual({
      kind: "create",
      status: "in_progress",
    });
    expect(decideCheckAction([doneNeutral], "in_progress")).toEqual({
      kind: "create",
      status: "in_progress",
    });
  });

  it("neutral patches an open check and creates when none exists", () => {
    expect(decideCheckAction([open], "neutral")).toEqual({
      kind: "patch",
      id: 1,
      status: "completed",
      conclusion: "neutral",
    });
    expect(decideCheckAction([], "neutral")).toEqual({
      kind: "create",
      status: "completed",
      conclusion: "neutral",
    });
  });

  it("neutral is idempotent once recorded", () => {
    expect(decideCheckAction([doneNeutral], "neutral").kind).toBe("noop");
  });

  it("failure patches an open check but never overwrites a completed review (forward-only)", () => {
    expect(decideCheckAction([open], "failure")).toEqual({
      kind: "patch",
      id: 1,
      status: "completed",
      conclusion: "failure",
    });
    expect(decideCheckAction([doneNeutral], "failure").kind).toBe("noop");
  });

  it("failure is idempotent and picks the most recent check by id", () => {
    expect(decideCheckAction([doneFailure], "failure").kind).toBe("noop");
    // A settled neutral is newer (higher id) than an open check → the review completed, so no failure.
    expect(decideCheckAction([open, doneNeutral], "failure").kind).toBe("noop");
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
      id: 4,
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
    const ownedNeutral: ExistingCheck = {
      id: 7,
      status: "completed",
      conclusion: "neutral",
      detailsUrl: "https://github.com/o/r/actions/runs/123",
    };
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

  it("makes no write call when the decision is a no-op (an already-neutral check)", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const ghApi = (args: readonly string[]): Promise<string> => {
      calls.push({ args });
      return Promise.resolve(
        '{"id":1,"status":"completed","conclusion":"neutral","details_url":null}',
      );
    };
    await checkRun({ repo: "o/r", headSha: "abc", intent: "neutral", runUrl: "u" }, ghApi);
    expect(calls.some((c) => c.args.includes("POST") || c.args.includes("PATCH"))).toBe(false);
  });

  it("makes no write call when a cancelled run owns no check", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const ghApi = (args: readonly string[]): Promise<string> => {
      calls.push({ args });
      return Promise.resolve("[]");
    };
    await checkRun(
      { repo: "o/r", headSha: "abc", intent: "cancelled", runUrl: "https://g/runs/123" },
      ghApi,
    );
    expect(calls.some((c) => c.args.includes("POST") || c.args.includes("PATCH"))).toBe(false);
  });
});
