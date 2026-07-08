import { describe, it, expect } from "vitest";
import {
  decideBudget,
  isConvergenceTool,
  budgetMessage,
  evaluateBudgetHook,
  parseWallMs,
  parseFraction,
  budgetHookCommand,
  type BudgetInputs,
  type BudgetParams,
} from "./budget.js";

const inputs = (o: Partial<BudgetInputs>): BudgetInputs => ({
  spentUsd: null,
  budgetUsd: null,
  elapsedMs: null,
  wallMs: null,
  softFrac: 0.7,
  hardFrac: 0.9,
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

  it("takes the further-along axis when both are known (either limit converges the agent)", () => {
    const phase = decideBudget(
      inputs({ spentUsd: 0.2, budgetUsd: 1, elapsedMs: 950, wallMs: 1000 }),
    );
    expect(phase.kind).toBe("hard");
    if (phase.kind !== "ok") expect(phase.fraction).toBeCloseTo(0.95, 5);
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
});

describe("isConvergenceTool", () => {
  const draft = "/work/findings.json";
  it("always allows Read", () => {
    expect(isConvergenceTool("Read", { file_path: "/anything.ts" }, draft)).toBe(true);
  });
  it("allows Write/Edit only to the draft", () => {
    expect(isConvergenceTool("Write", { file_path: draft }, draft)).toBe(true);
    expect(isConvergenceTool("Edit", { file_path: draft }, draft)).toBe(true);
    expect(isConvergenceTool("Write", { file_path: "/work/src/x.ts" }, draft)).toBe(false);
  });
  it("resolves relative vs absolute draft paths equivalently", () => {
    expect(isConvergenceTool("Write", { file_path: "/work/./findings.json" }, draft)).toBe(true);
  });
  it("allows Bash only when it invokes code-review", () => {
    expect(
      isConvergenceTool("Bash", { command: "code-review validate /work/findings.json" }, draft),
    ).toBe(true);
    expect(isConvergenceTool("Bash", { command: "grep -r TODO src/" }, draft)).toBe(false);
  });
  it("denies new investigation and subagent spawns", () => {
    expect(isConvergenceTool("Agent", { prompt: "go find bugs" }, draft)).toBe(false);
    expect(isConvergenceTool("Task", {}, draft)).toBe(false);
    expect(isConvergenceTool("WebSearch", {}, draft)).toBe(false);
  });
});

describe("budgetMessage", () => {
  const draft = "/work/findings.json";
  it("reports both axes and the hard directive when hard", () => {
    const msg = budgetMessage(
      inputs({ spentUsd: 0.95, budgetUsd: 1, elapsedMs: 60_000, wallMs: 120_000 }),
      { kind: "hard", fraction: 0.95 },
      draft,
    );
    expect(msg).toContain("$0.95/$1.00");
    expect(msg).toContain("elapsed");
    expect(msg).toContain("STOP all new investigation");
    expect(msg).toContain(draft);
  });
  it("uses the softer directive when soft", () => {
    const msg = budgetMessage(
      inputs({ spentUsd: 0.75, budgetUsd: 1 }),
      { kind: "soft", fraction: 0.75 },
      draft,
    );
    expect(msg).toContain("Wind down investigation");
    expect(msg).not.toContain("STOP all new investigation");
  });
  it("omits the time clause when elapsed is unknown, and the denominator when budget is unknown", () => {
    const msg = budgetMessage(inputs({ spentUsd: 0.5 }), { kind: "soft", fraction: 0.75 }, draft);
    expect(msg).toContain("spent $0.50");
    expect(msg).not.toContain("/$");
    expect(msg).not.toContain("elapsed");
  });
  it("omits the spend clause (never '$0.00') when spend is unmeasurable, showing only time", () => {
    const msg = budgetMessage(
      inputs({ spentUsd: null, elapsedMs: 60_000, wallMs: 120_000 }),
      { kind: "soft", fraction: 0.5 },
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
    softFrac: 0.7,
    hardFrac: 0.9,
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
  it("PreToolUse: denies an unknown/mis-shaped tool name at hard (deliverable first)", () => {
    expect(
      evaluateBudgetHook({ hook_event_name: "PreToolUse", tool_input: {} }, hard),
    ).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
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
    expect(parseFraction("0", 0.7)).toBe(0.7);
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
