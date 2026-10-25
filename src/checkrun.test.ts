import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { checkLines, doneCheck, openCheck } from "./test-util.js";
import {
  CHECK_JQ,
  checkRun,
  externalIdFor,
  INCOMPLETE_REMEDY,
  decideCheckAction,
  decideCancelledAction,
  runIdFromUrl,
  supersededOnHead,
  type ExistingCheck,
} from "./checkrun.js";

// A gh api double: the listing answers with `checks` (the post-jq lines), every write with "{}".
const capture = (checks = "") => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const ghApi = (args: readonly string[], stdin?: string): Promise<string> => {
    calls.push({ args, stdin });
    return Promise.resolve(args[0]?.includes("/check-runs?check_name=") === true ? checks : "{}");
  };
  return { calls, ghApi };
};

const ownedOpen = openCheck(1, "123");
const ownedNeutral = doneCheck(2, "123", "neutral");
const ownedFailure = doneCheck(3, "123", "failure");
const ownedCancelled = doneCheck(4, "123", "cancelled");
const successorOpen = openCheck(5, "1234");
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
    expect(runIdFromUrl("https://github.com/o/r/actions/runs/123/job/456")).toBe("123");
    expect(runIdFromUrl("https://github.com/o/r/actions/runs/123/attempts/2")).toBe("123");
  });

  it("returns null for a URL that carries no run id", () => {
    expect(runIdFromUrl("")).toBeNull();
    expect(runIdFromUrl("https://github.com/o/r")).toBeNull();
    expect(runIdFromUrl("https://github.com/o/r/actions/runs/")).toBeNull();
    expect(runIdFromUrl("https://github.com/o/r/actions/runs/123abc")).toBeNull();
  });
});

describe("decideCancelledAction — issue #139", () => {
  it("settles ONLY the check this run's announce created (matched by the run in its external_id)", () => {
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

  it("no-ops when this run created no check (e.g. the announce never ran), though a successor whose run id extends this one's has", () => {
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
});

describe("checkRun", () => {
  it("POSTs a new in_progress check on the head sha when none exists", async () => {
    const { calls, ghApi } = capture();
    await checkRun({ repo: "o/r", headSha: "abc", intent: "in_progress", runUrl: "u" }, ghApi);
    const write = calls.find((c) => c.args.includes("POST"));
    expect(write?.args).toContain("repos/o/r/check-runs");
    const body = JSON.parse(write?.stdin ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Code review", head_sha: "abc", status: "in_progress" });
  });

  it("a failure check blames no job, since finalize also files one when only the comment job died", async () => {
    const { calls, ghApi } = capture();
    await checkRun({ repo: "o/r", headSha: "abc", intent: "failure", runUrl: "u" }, ghApi);
    const body = JSON.parse(calls.find((c) => c.args.includes("POST"))?.stdin ?? "{}") as {
      output?: { summary?: string };
    };
    expect(body.output?.summary).not.toContain("review job failed");
    // The check can be filed over a review that landed but lost its posted signal, so it claims only
    // what the run knows: that it did not confirm the post.
    expect(body.output?.summary).not.toContain("never reached");
    expect(body.output?.summary).toContain(INCOMPLETE_REMEDY);
  });

  it("settles a superseded run's failure as cancelled — a newer run's check is on the head", async () => {
    const { calls, ghApi } = capture(checkLines(openCheck(1, "123"), openCheck(2, "124")));
    await checkRun(
      { repo: "o/r", headSha: "abc", intent: "failure", runUrl: "https://g/actions/runs/123" },
      ghApi,
    );
    const patch = calls.find((c) => c.args.includes("PATCH"));
    expect(patch?.args).toContain("repos/o/r/check-runs/1");
    const body = JSON.parse(patch?.stdin ?? "{}") as {
      conclusion?: string;
      output?: { title?: string; summary?: string };
    };
    expect(body.conclusion).toBe("cancelled");
    expect(body.output?.title).toBe("Code review superseded");
    expect(body.output?.summary).not.toContain(INCOMPLETE_REMEDY);
  });

  it("makes no write call when the decision is a no-op (already-neutral owned check)", async () => {
    const { calls, ghApi } = capture(checkLines(doneCheck(1, "123", "neutral")));
    await checkRun(
      { repo: "o/r", headSha: "abc", intent: "neutral", runUrl: "https://g/actions/runs/123" },
      ghApi,
    );
    expect(calls.some((c) => c.args.includes("POST") || c.args.includes("PATCH"))).toBe(false);
  });

  it("makes no write call when a cancelled run owns no check", async () => {
    const { calls, ghApi } = capture();
    await checkRun(
      { repo: "o/r", headSha: "abc", intent: "cancelled", runUrl: "https://g/actions/runs/123" },
      ghApi,
    );
    expect(calls.some((c) => c.args.includes("POST") || c.args.includes("PATCH"))).toBe(false);
  });
});

describe("supersededOnHead", () => {
  const check = (runId: string | null): ExistingCheck => openCheck(1, runId);
  const runUrl = "https://g/actions/runs/123";

  it("is true only when a check names a newer run", () => {
    expect(supersededOnHead([check("124")], runUrl)).toBe(true);
    expect(supersededOnHead([check("123"), check("99")], runUrl)).toBe(false);
    expect(supersededOnHead([check(null)], runUrl)).toBe(false);
    expect(supersededOnHead([], runUrl)).toBe(false);
  });

  it("compares run ids as numbers, not strings (1000 is newer than 999)", () => {
    expect(supersededOnHead([check("1000")], "https://g/actions/runs/999")).toBe(true);
  });
});

describe("check ownership — the run id GitHub keeps", () => {
  const runUrl = "https://github.com/o/r/actions/runs/123";

  it("matches a check by its external_id, not by a details_url GitHub rewrote", () => {
    const own = doneCheck(7, "123", "failure");
    expect(decideCheckAction([own], "neutral", runUrl)).toEqual({
      kind: "patch",
      id: 7,
      status: "completed",
      conclusion: "neutral",
    });
    expect(decideCheckAction([doneCheck(8, null, "failure")], "neutral", runUrl).kind).toBe(
      "create",
    );
  });

  it("owns no check by another app's bare numeric external_id", () => {
    const otherApp: ExistingCheck = { ...openCheck(9, null), externalId: "123" };
    expect(decideCancelledAction([otherApp], runUrl).kind).toBe("noop");
    expect(supersededOnHead([{ ...otherApp, externalId: "999" }], runUrl)).toBe(false);
  });

  it("lets a failure and a cancellation replace each other on the run's own check", () => {
    expect(decideCancelledAction([doneCheck(1, "123", "failure")], runUrl)).toMatchObject({
      kind: "patch",
      conclusion: "cancelled",
    });
    expect(decideCheckAction([doneCheck(1, "123", "cancelled")], "failure", runUrl)).toMatchObject({
      kind: "patch",
      conclusion: "failure",
    });
  });

  it.skipIf(spawnSync("jq", ["--version"]).status !== 0)(
    "reads the run from GitHub's own records through CHECK_JQ",
    () => {
      const raw = JSON.stringify({
        total_count: 3,
        check_runs: [
          {
            id: 7,
            status: "in_progress",
            conclusion: null,
            details_url: "https://github.com/o/r/runs/7",
            external_id: externalIdFor("123"),
          },
          {
            id: 8,
            status: "completed",
            conclusion: "neutral",
            details_url: "https://github.com/o/r/runs/8",
            external_id: "",
          },
          {
            // A run URL in details_url is never read: only the stamped external_id owns a check.
            id: 9,
            status: "in_progress",
            conclusion: null,
            details_url: "https://github.com/o/r/actions/runs/123",
            external_id: "",
          },
        ],
      });
      const checks = execFileSync("jq", ["-c", CHECK_JQ], { input: raw, encoding: "utf-8" })
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as ExistingCheck);
      expect(decideCancelledAction(checks, runUrl)).toMatchObject({ kind: "patch", id: 7 });
      expect(
        decideCancelledAction(
          checks.filter((check) => check.id === 9),
          runUrl,
        ).kind,
      ).toBe("noop");
    },
  );

  it("stamps the run into external_id on create, and lists one page of the checks of every state under the name it creates", async () => {
    const { calls, ghApi } = capture();
    await checkRun({ repo: "o/r", headSha: "abc", intent: "in_progress", runUrl }, ghApi);
    const listing = new URL(`https://api.github.com/${calls[0]?.args[0] ?? ""}`).searchParams;
    expect(listing.get("filter")).toBe("all");
    expect(listing.get("per_page")).toBe("100");
    expect(calls[0]?.args.slice(1)).toEqual(["--jq", CHECK_JQ]);
    const post = calls.find((c) => c.args.includes("POST"));
    expect(JSON.parse(post?.stdin ?? "{}")).toMatchObject({
      name: listing.get("check_name"),
      external_id: externalIdFor("123"),
    });
  });
});
