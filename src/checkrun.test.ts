import { describe, it, expect } from "vitest";
import { checkRun, decideCheckAction, type ExistingCheck } from "./checkrun.js";

const open: ExistingCheck = { id: 1, status: "in_progress", conclusion: null };
const doneNeutral: ExistingCheck = { id: 2, status: "completed", conclusion: "neutral" };
const doneFailure: ExistingCheck = { id: 3, status: "completed", conclusion: "failure" };
const doneCancelled: ExistingCheck = { id: 4, status: "completed", conclusion: "cancelled" };

describe("decideCheckAction", () => {
  it("in_progress creates when none exists and no-ops when one is already open", () => {
    expect(decideCheckAction([], "in_progress")).toEqual({ kind: "create", status: "in_progress" });
    expect(decideCheckAction([open], "in_progress").kind).toBe("noop");
  });

  it("in_progress re-creates once the prior check has settled", () => {
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

  it("superseded settles an open check to conclusion cancelled (issue #139)", () => {
    expect(decideCheckAction([open], "superseded")).toEqual({
      kind: "patch",
      id: 1,
      status: "completed",
      conclusion: "cancelled",
    });
    expect(decideCheckAction([], "superseded")).toEqual({
      kind: "create",
      status: "completed",
      conclusion: "cancelled",
    });
  });

  it("superseded is idempotent once recorded as cancelled", () => {
    expect(decideCheckAction([doneCancelled], "superseded").kind).toBe("noop");
  });

  it("superseded never overwrites a completed review, and a later failure may overwrite a cancelled check", () => {
    // A superseded run must not clobber a real completed review on this head.
    expect(decideCheckAction([doneNeutral], "superseded").kind).toBe("noop");
    // `cancelled` is NOT in the settled set, so a genuine same-head failure can still stamp `failure`.
    expect(decideCheckAction([doneCancelled], "failure").kind).toBe("patch");
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

  it("makes no write call when the decision is a no-op", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const ghApi = (args: readonly string[]): Promise<string> => {
      calls.push({ args });
      return Promise.resolve('{"id":1,"status":"in_progress","conclusion":null}');
    };
    await checkRun({ repo: "o/r", headSha: "abc", intent: "in_progress", runUrl: "u" }, ghApi);
    expect(calls.some((c) => c.args.includes("POST") || c.args.includes("PATCH"))).toBe(false);
  });

  it("PATCHes an open check to conclusion cancelled for a superseded run (issue #139)", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const ghApi = (args: readonly string[], stdin?: string): Promise<string> => {
      calls.push({ args, stdin });
      if (args[0]?.includes("/check-runs?check_name=")) {
        return Promise.resolve('{"id":1,"status":"in_progress","conclusion":null}');
      }
      return Promise.resolve("{}");
    };
    await checkRun({ repo: "o/r", headSha: "abc", intent: "superseded", runUrl: "u" }, ghApi);
    const patch = calls.find((c) => c.args.includes("PATCH"));
    expect(patch).toBeDefined();
    const body = JSON.parse(patch?.stdin ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ status: "completed", conclusion: "cancelled" });
    const output = body["output"] as { title: string; summary: string };
    expect(output.title).toBe("Code review superseded");
    expect(output.summary).toContain("No action needed");
  });
});
