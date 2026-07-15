import { describe, it, expect, vi } from "vitest";
import type { GhApi } from "./gh.js";
import type { ParseOptions } from "./command.js";
import {
  parseCommandArgs,
  parseCommand,
  renderCommandOutputs,
  safeHeredocDelim,
} from "./command.js";

const OPTS: ParseOptions = {
  trigger: "/code-review",
  maxDurationSec: 3600,
  maxUsd: 5,
  maxInstructionsLen: 4000,
};

const asCommand = (body: string, opts: ParseOptions = OPTS) => {
  const parsed = parseCommandArgs(body, opts);
  if (parsed.kind !== "command") throw new Error(`expected a command, got ${parsed.kind}`);
  return parsed.args;
};

describe("parseCommandArgs — trigger recognition", () => {
  it("rejects a body that does not begin with the trigger", () => {
    expect(parseCommandArgs("please review this", OPTS).kind).toBe("not-a-command");
  });

  it("rejects the trigger as a non-whole token (/code-reviewer)", () => {
    expect(parseCommandArgs("/code-reviewer 24m", OPTS).kind).toBe("not-a-command");
  });

  it("accepts a bare trigger with no args", () => {
    expect(asCommand("/code-review")).toEqual({
      durationSec: null,
      usd: null,
      instructions: "",
      notes: [],
    });
  });

  it("tolerates leading whitespace before the trigger", () => {
    expect(asCommand("   /code-review look here").instructions).toBe("look here");
  });

  it("honors a custom trigger token", () => {
    const opts = { ...OPTS, trigger: "@code-review" };
    expect(parseCommandArgs("@code-review 10m go", opts).kind).toBe("command");
    expect(parseCommandArgs("/code-review 10m go", opts).kind).toBe("not-a-command");
  });
});

describe("parseCommandArgs — duration + usd tokens", () => {
  it("parses a leading duration token to seconds", () => {
    expect(asCommand("/code-review 10m").durationSec).toBe(600);
    expect(asCommand("/code-review 30s").durationSec).toBe(30);
    expect(asCommand("/code-review 1h").durationSec).toBe(3600);
  });

  it("parses a leading dollar token", () => {
    expect(asCommand("/code-review $1.50").usd).toBe(1.5);
    expect(asCommand("/code-review $2").usd).toBe(2);
  });

  it("accepts duration and usd in either order, then instructions", () => {
    expect(asCommand("/code-review 10m $2.00 focus on X")).toMatchObject({
      durationSec: 600,
      usd: 2,
      instructions: "focus on X",
    });
    expect(asCommand("/code-review $2.00 10m focus on X")).toMatchObject({
      durationSec: 600,
      usd: 2,
      instructions: "focus on X",
    });
  });

  it("treats a duration-looking token INSIDE prose as instructions, not a knob", () => {
    const args = asCommand("/code-review please spend 24m on the parser");
    expect(args.durationSec).toBeNull();
    expect(args.instructions).toBe("please spend 24m on the parser");
  });

  it("stops consuming knobs at the first unrecognized token (a later 24m stays prose)", () => {
    const args = asCommand("/code-review $1.00 audit 24m budget");
    expect(args.usd).toBe(1);
    expect(args.durationSec).toBeNull();
    expect(args.instructions).toBe("audit 24m budget");
  });

  it("treats a second duration token as the start of instructions (first wins)", () => {
    const args = asCommand("/code-review 10m 20m go");
    expect(args.durationSec).toBe(600);
    expect(args.instructions).toBe("20m go");
  });

  it("does not treat a bare number (no unit) as a duration", () => {
    const args = asCommand("/code-review 24 things to check");
    expect(args.durationSec).toBeNull();
    expect(args.instructions).toBe("24 things to check");
  });
});

describe("parseCommandArgs — clamping + capping", () => {
  it("clamps a duration above the ceiling and records a note", () => {
    const args = asCommand("/code-review 2h review deeply", { ...OPTS, maxDurationSec: 3600 });
    expect(args.durationSec).toBe(3600);
    expect(args.notes.some((n) => n.includes("clamped to 3600s"))).toBe(true);
  });

  it("clamps a usd above the ceiling and records a note", () => {
    const args = asCommand("/code-review $9.99 go", { ...OPTS, maxUsd: 5 });
    expect(args.usd).toBe(5);
    expect(args.notes.some((n) => n.includes("clamped to $5.00"))).toBe(true);
  });

  it("leaves in-bounds values unclamped with no notes", () => {
    const args = asCommand("/code-review 30m $1.00 fine");
    expect(args.durationSec).toBe(1800);
    expect(args.usd).toBe(1);
    expect(args.notes).toEqual([]);
  });

  it("does not clamp when no ceiling is configured", () => {
    const args = asCommand("/code-review 10h $999 unbounded", {
      ...OPTS,
      maxDurationSec: null,
      maxUsd: null,
    });
    expect(args.durationSec).toBe(36000);
    expect(args.usd).toBe(999);
  });

  it("truncates instructions past the cap and records a note", () => {
    const long = "x".repeat(50);
    const args = asCommand(`/code-review ${long}`, { ...OPTS, maxInstructionsLen: 10 });
    expect(args.instructions).toBe("x".repeat(10));
    expect(args.notes.some((n) => n.includes("truncated"))).toBe(true);
  });

  it("preserves multi-line instructions verbatim (minus outer trim)", () => {
    const args = asCommand("/code-review 5m line one\n\nline two");
    expect(args.instructions).toBe("line one\n\nline two");
  });
});

describe("safeHeredocDelim", () => {
  it("prefixes GHOUT_ and returns the first non-colliding candidate", () => {
    expect(safeHeredocDelim("some\ninstructions", () => "abc123")).toBe("GHOUT_abc123");
  });

  it("draws again when a candidate collides with an instruction line", () => {
    const seq = ["dup", "dup", "fresh"];
    let i = 0;
    const delim = safeHeredocDelim("a\nGHOUT_dup\nb", () => seq[i++] ?? "x");
    expect(delim).toBe("GHOUT_fresh");
  });

  it("throws if it cannot find a free delimiter within the attempt budget", () => {
    expect(() => safeHeredocDelim("GHOUT_x", () => "x", 0)).toThrow(/collision-free/);
  });
});

describe("renderCommandOutputs", () => {
  it("emits only should_run=false for a skip", () => {
    expect(renderCommandOutputs({ kind: "skip", reason: "closed" }, "D")).toBe(
      "should_run=false\n",
    );
  });

  it("emits every output line + a heredoc-wrapped instructions block for a run", () => {
    const out = renderCommandOutputs(
      {
        kind: "run",
        headSha: "abc",
        headBranch: "feat/x",
        headRepo: "o/r",
        args: { durationSec: 600, usd: 1, instructions: "do X\ndo Y", notes: [] },
      },
      "GHOUT_deadbeef",
    );
    expect(out).toBe(
      [
        "should_run=true",
        "head_sha=abc",
        "head_branch=feat/x",
        "head_repo=o/r",
        "duration=600s",
        "usd=1.00",
        "instructions<<GHOUT_deadbeef",
        "do X",
        "do Y",
        "GHOUT_deadbeef",
        "",
      ].join("\n"),
    );
  });

  it("emits empty duration/usd fields when the commenter set neither", () => {
    const out = renderCommandOutputs(
      {
        kind: "run",
        headSha: "s",
        headBranch: "b",
        headRepo: "o/r",
        args: { durationSec: null, usd: null, instructions: "", notes: [] },
      },
      "D",
    );
    expect(out).toContain("duration=\n");
    expect(out).toContain("usd=\n");
  });
});

const mkMockGhApi = (
  responses: ReadonlyArray<{
    readonly match: (args: readonly string[]) => boolean;
    readonly response: string | Error;
  }>,
): GhApi => {
  return (args) => {
    for (const r of responses) {
      if (r.match(args))
        return r.response instanceof Error
          ? Promise.reject(r.response)
          : Promise.resolve(r.response);
    }
    return Promise.reject(new Error(`Unexpected gh api call: ${args.join(" ")}`));
  };
};

const prHeadMatch = (a: readonly string[]): boolean =>
  a[0] === "repos/owner/repo/pulls/42" && a.includes("--jq");

describe("parseCommand — PR resolution", () => {
  it("resolves an open PR's head from its NUMBER and returns run", async () => {
    const api = mkMockGhApi([
      {
        match: prHeadMatch,
        response: JSON.stringify({
          head_sha: "deadbeef",
          head_ref: "feature-branch",
          head_repo: "fork/repo",
          state: "open",
        }),
      },
    ]);
    const result = await parseCommand(
      { repo: "owner/repo", prNumber: 42, body: "/code-review 10m go", options: OPTS },
      api,
    );
    expect(result).toEqual({
      kind: "run",
      headSha: "deadbeef",
      headBranch: "feature-branch",
      headRepo: "fork/repo",
      args: { durationSec: 600, usd: null, instructions: "go", notes: [] },
    });
  });

  it("falls back to the caller repo when head.repo is null (deleted fork)", async () => {
    const api = mkMockGhApi([
      {
        match: prHeadMatch,
        response: JSON.stringify({
          head_sha: "s",
          head_ref: "b",
          head_repo: null,
          state: "open",
        }),
      },
    ]);
    const result = await parseCommand(
      { repo: "owner/repo", prNumber: 42, body: "/code-review", options: OPTS },
      api,
    );
    expect(result.kind).toBe("run");
    if (result.kind === "run") expect(result.headRepo).toBe("owner/repo");
  });

  it("skips (never resolves) when the comment is not the trigger — no API call", async () => {
    const api = vi.fn(mkMockGhApi([]));
    const result = await parseCommand(
      { repo: "owner/repo", prNumber: 42, body: "not a command", options: OPTS },
      api,
    );
    expect(result.kind).toBe("skip");
    expect(api).not.toHaveBeenCalled();
  });

  it("skips when the PR is not open", async () => {
    const api = mkMockGhApi([
      {
        match: prHeadMatch,
        response: JSON.stringify({
          head_sha: "s",
          head_ref: "b",
          head_repo: "o/r",
          state: "closed",
        }),
      },
    ]);
    const result = await parseCommand(
      { repo: "owner/repo", prNumber: 42, body: "/code-review go", options: OPTS },
      api,
    );
    expect(result).toMatchObject({ kind: "skip" });
    if (result.kind === "skip") expect(result.reason).toContain("not open");
  });

  it("skips (does not throw) when the head resolution fails", async () => {
    const api = mkMockGhApi([{ match: prHeadMatch, response: new Error("404") }]);
    const result = await parseCommand(
      { repo: "owner/repo", prNumber: 42, body: "/code-review go", options: OPTS },
      api,
    );
    expect(result).toMatchObject({ kind: "skip" });
    if (result.kind === "skip") expect(result.reason).toContain("could not resolve");
  });
});
