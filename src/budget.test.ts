import { describe, it, expect } from "vitest";
import {
  decideBudget,
  blockedDuringConvergence,
  budgetMessage,
  evaluateBudgetHook,
  parseWallMs,
  parseFraction,
  budgetHookCommand,
  type BudgetInputs,
  type BudgetParams,
} from "./budget.js";

// Flat reserves default to 0 here so the fraction alone drives — the flat-floor behaviour is
// exercised by its own tests below.
const inputs = (o: Partial<BudgetInputs>): BudgetInputs => ({
  spentUsd: null,
  budgetUsd: null,
  elapsedMs: null,
  wallMs: null,
  reserve: { frac: 0.15, flatUsd: 0, flatMs: 0 },
  ...o,
});

describe("decideBudget", () => {
  it("is ok when neither axis is measurable", () => {
    expect(decideBudget(inputs({ spentUsd: 5 }))).toEqual({ kind: "ok" });
  });

  it("drives on the cost axis alone: below soft → ok, past soft → soft, past hard → hard", () => {
    expect(decideBudget(inputs({ spentUsd: 0.1, budgetUsd: 1 })).kind).toBe("ok");
    expect(decideBudget(inputs({ spentUsd: 0.75, budgetUsd: 1 })).kind).toBe("soft");
    expect(decideBudget(inputs({ spentUsd: 0.95, budgetUsd: 1 })).kind).toBe("hard");
  });

  it("drives on the time axis alone", () => {
    expect(decideBudget(inputs({ elapsedMs: 300, wallMs: 1000 })).kind).toBe("ok");
    expect(decideBudget(inputs({ elapsedMs: 800, wallMs: 1000 })).kind).toBe("soft");
    expect(decideBudget(inputs({ elapsedMs: 950, wallMs: 1000 })).kind).toBe("hard");
  });

  it("takes the more-severe axis when both are known (either limit converges the agent)", () => {
    expect(
      decideBudget(inputs({ spentUsd: 0.2, budgetUsd: 1, elapsedMs: 950, wallMs: 1000 })).kind,
    ).toBe("hard");
  });

  it("disables the cost axis when the budget is zero (no divide-by-zero, no false 'infinite' spend)", () => {
    expect(decideBudget(inputs({ spentUsd: 5, budgetUsd: 0 })).kind).toBe("ok");
  });

  it("disables the cost axis when spend is unmeasurable, even with a budget set — never a false zero", () => {
    expect(decideBudget(inputs({ spentUsd: null, budgetUsd: 1 })).kind).toBe("ok");
    expect(
      decideBudget(inputs({ spentUsd: null, budgetUsd: 1, elapsedMs: 950, wallMs: 1000 })).kind,
    ).toBe("hard");
  });

  it("lets the flat floor force convergence when a tiny budget can't cover the wind-down reserve", () => {
    // 60s wall, but a 2-minute flat floor means less than the reserve remains from the start.
    const r = { frac: 0.15, flatUsd: 0.02, flatMs: 120_000 };
    expect(decideBudget(inputs({ elapsedMs: 5_000, wallMs: 60_000, reserve: r })).kind).toBe(
      "hard",
    );
    // $0.05 budget, $0.02 flat: soft once < $0.04 remains, hard once < $0.02 remains.
    expect(decideBudget(inputs({ spentUsd: 0.02, budgetUsd: 0.05, reserve: r })).kind).toBe("soft");
    expect(decideBudget(inputs({ spentUsd: 0.04, budgetUsd: 0.05, reserve: r })).kind).toBe("hard");
  });
});

describe("blockedDuringConvergence", () => {
  it("blocks subagent spawns (the #38 fan-out) and web calls", () => {
    expect(blockedDuringConvergence("Agent", { prompt: "go find bugs" })).toBe(true);
    expect(blockedDuringConvergence("Task", {})).toBe(true);
    expect(blockedDuringConvergence("WebFetch", { url: "http://x" })).toBe(true);
    expect(blockedDuringConvergence("WebSearch", {})).toBe(true);
  });
  it("blocks arbitrary Bash but allows `code-review validate` (not other subcommands)", () => {
    expect(blockedDuringConvergence("Bash", { command: "grep -r TODO src/" })).toBe(true);
    expect(blockedDuringConvergence("Bash", { command: "code-review gather" })).toBe(true);
    // `validate-patches` is a different, findings-mutating command — must NOT slip past as `validate`.
    expect(
      blockedDuringConvergence("Bash", { command: "code-review validate-patches f.json" }),
    ).toBe(true);
    expect(blockedDuringConvergence("Bash", { command: "code-review validate /work/f.json" })).toBe(
      false,
    );
  });
  it("never blocks the deliver-the-draft path: Read, Write/Edit anywhere, and terminal answer tools", () => {
    expect(blockedDuringConvergence("Read", { file_path: "/anything.ts" })).toBe(false);
    expect(blockedDuringConvergence("Write", { file_path: "/work/findings.json" })).toBe(false);
    expect(blockedDuringConvergence("Edit", { file_path: "/work/src/x.ts" })).toBe(false);
    expect(blockedDuringConvergence("StructuredOutput", {})).toBe(false);
    expect(blockedDuringConvergence("ReportFindings", {})).toBe(false);
  });
});

describe("budgetMessage", () => {
  const draft = "/work/findings.json";
  it("reports both axes and the hard directive when hard", () => {
    const msg = budgetMessage(
      inputs({ spentUsd: 0.95, budgetUsd: 1, elapsedMs: 60_000, wallMs: 120_000 }),
      { kind: "hard" },
      draft,
    );
    expect(msg).toContain("$0.95/$1.00");
    expect(msg).toContain("elapsed");
    expect(msg).toContain("STOP all new investigation");
    expect(msg).toContain(draft);
  });
  it("uses the softer directive when soft", () => {
    const msg = budgetMessage(inputs({ spentUsd: 0.75, budgetUsd: 1 }), { kind: "soft" }, draft);
    expect(msg).toContain("Wind down investigation");
    expect(msg).not.toContain("STOP all new investigation");
  });
  it("omits the time clause when elapsed is unknown, and the denominator when budget is unknown", () => {
    const msg = budgetMessage(inputs({ spentUsd: 0.5 }), { kind: "soft" }, draft);
    expect(msg).toContain("spent $0.50");
    expect(msg).not.toContain("/$");
    expect(msg).not.toContain("elapsed");
  });
  it("omits the spend clause (never '$0.00') when spend is unmeasurable, showing only time", () => {
    const msg = budgetMessage(
      inputs({ spentUsd: null, elapsedMs: 60_000, wallMs: 120_000 }),
      { kind: "soft" },
      draft,
    );
    expect(msg).not.toContain("spent");
    expect(msg).not.toContain("$");
    expect(msg).toContain("elapsed");
  });
});

describe("evaluateBudgetHook", () => {
  const draft = "/work/findings.json";
  const params = (o: Partial<BudgetParams>): BudgetParams => ({
    spentUsd: null,
    budgetUsd: null,
    elapsedMs: null,
    wallMs: null,
    reserve: { frac: 0.15, flatUsd: 0, flatMs: 0 },
    draftPath: draft,
    ...o,
  });
  const hard = params({ spentUsd: 0.95, budgetUsd: 1 });
  const soft = params({ spentUsd: 0.75, budgetUsd: 1 });
  const ok = params({ spentUsd: 0.1, budgetUsd: 1 });

  it("PostToolBatch: silent (no-op) below soft", () => {
    expect(evaluateBudgetHook({ hook_event_name: "PostToolBatch" }, ok)).toEqual({});
  });
  it("PostToolBatch: injects additionalContext at soft", () => {
    const out = evaluateBudgetHook({ hook_event_name: "PostToolBatch" }, soft) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolBatch");
    expect(out.hookSpecificOutput.additionalContext).toContain("Wind down");
  });
  it("PostToolBatch: injects additionalContext at hard too (steer never goes away)", () => {
    const out = evaluateBudgetHook({ hook_event_name: "PostToolBatch" }, hard) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(out.hookSpecificOutput.additionalContext).toContain("STOP all new investigation");
  });

  it("PreToolUse: allows everything below hard (soft does not deny)", () => {
    expect(
      evaluateBudgetHook(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
        soft,
      ),
    ).toEqual({});
  });
  it("PreToolUse: denies a non-convergence tool at hard", () => {
    const out = evaluateBudgetHook(
      { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { prompt: "hunt" } },
      hard,
    ) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("STOP all new investigation");
  });
  it("PreToolUse: allows the convergence path at hard (Write to draft, Read, code-review Bash)", () => {
    expect(
      evaluateBudgetHook(
        { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: draft } },
        hard,
      ),
    ).toEqual({});
    expect(
      evaluateBudgetHook(
        { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } },
        hard,
      ),
    ).toEqual({});
    expect(
      evaluateBudgetHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: `code-review validate ${draft}` },
        },
        hard,
      ),
    ).toEqual({});
  });
  it("PreToolUse: allows an unknown/mis-shaped tool name at hard (denylist blocks only known burners)", () => {
    expect(evaluateBudgetHook({ hook_event_name: "PreToolUse", tool_input: {} }, hard)).toEqual({});
  });
  it("PreToolUse: still forces convergence on the time axis when spend is unmeasurable", () => {
    const out = evaluateBudgetHook(
      { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: {} },
      params({ spentUsd: null, elapsedMs: 950, wallMs: 1000 }),
    ) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain("$");
  });
  it("no-ops for an unknown event or a non-object input", () => {
    expect(evaluateBudgetHook({ hook_event_name: "SessionStart" }, hard)).toEqual({});
    expect(evaluateBudgetHook(null, hard)).toEqual({});
    expect(evaluateBudgetHook("not-json", hard)).toEqual({});
  });
});

describe("parseWallMs", () => {
  it.each([
    ["20m", 1_200_000],
    ["1200s", 1_200_000],
    ["2h", 7_200_000],
    ["500ms", 500],
    ["90", 90_000],
  ])("parses %s → %d ms", (raw, ms) => {
    expect(parseWallMs(raw)).toBe(ms);
  });
  it("returns null for unparseable input", () => {
    expect(parseWallMs("soon")).toBeNull();
    expect(parseWallMs("")).toBeNull();
  });
});

describe("parseFraction", () => {
  it("falls back for absent, out-of-range, or unparseable values; keeps valid ones", () => {
    expect(parseFraction(undefined, 0.7)).toBe(0.7);
    expect(parseFraction("0.85", 0.7)).toBe(0.85);
    expect(parseFraction("1", 0.7)).toBe(1);
    expect(parseFraction("0", 0.7)).toBe(0); // 0 is valid — disables the fraction, flat floor only
    expect(parseFraction("-0.1", 0.7)).toBe(0.7);
    expect(parseFraction("1.5", 0.7)).toBe(0.7);
    expect(parseFraction("abc", 0.7)).toBe(0.7);
  });
});

describe("budgetHookCommand", () => {
  it("re-invokes the CLI with the draft and only the flags that are set", () => {
    const cmd = budgetHookCommand("/work/findings.json", { budgetUsd: "2.5", wall: "20m" });
    expect(cmd).toContain("code-review budget-hook --draft '/work/findings.json'");
    expect(cmd).toContain("--budget-usd '2.5'");
    expect(cmd).toContain("--wall '20m'");
    expect(cmd).not.toContain("--prices");
    expect(cmd).not.toContain("--soft-frac");
  });
});
