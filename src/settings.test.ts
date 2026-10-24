import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { composeReviewSettings } from "./settings.js";

describe("composeReviewSettings", () => {
  const settings = composeReviewSettings({
    draftPath: "/work/findings.json",
    stop: { kind: "findings", maxNudges: "5" },
    budget: {
      budgetUsd: "2.5",
      wall: "20m",
      prices: "/work/prices.json",
      reserveFrac: "0.15",
      reserveUsd: "0.02",
      reserveWall: "2m",
    },
  });

  const stopCmd = settings.hooks.Stop[0]!.hooks[0]!.command;
  const preCmd = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
  const postCmd = settings.hooks.PostToolBatch[0]!.hooks[0]!.command;

  it("wires all three hook events, each with a single command", () => {
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolBatch).toHaveLength(1);
  });

  it("points Stop at the stop-gate with the draft and its flags", () => {
    expect(stopCmd).toContain("stop-gate --draft '/work/findings.json'");
    expect(stopCmd).toContain("--kind 'findings'");
    expect(stopCmd).toContain("--max-nudges '5'");
  });

  it("wires the SAME self-dispatching budget-hook command to both tool events", () => {
    expect(preCmd).toContain("budget-hook --draft '/work/findings.json'");
    expect(preCmd).toBe(postCmd);
  });

  it("propagates every budget limit into the budget command", () => {
    expect(preCmd).toContain("--budget-usd '2.5'");
    expect(preCmd).toContain("--wall '20m'");
    expect(preCmd).toContain("--prices '/work/prices.json'");
    expect(preCmd).toContain("--reserve-frac '0.15'");
    expect(preCmd).toContain("--reserve-usd '0.02'");
    expect(preCmd).toContain("--reserve-wall '2m'");
  });

  it("carries no matcher on the tool hooks, so they run for every tool (the CLI decides per tool)", () => {
    expect(settings.hooks.PreToolUse[0]).not.toHaveProperty("matcher");
    expect(settings.hooks.PostToolBatch[0]).not.toHaveProperty("matcher");
  });
});

describe("composeReviewSettings — the context every subagent starts with", () => {
  const withContext = (subagentContext?: string) =>
    composeReviewSettings({
      draftPath: "/work/findings.json",
      stop: {},
      budget: {},
      ...(subagentContext !== undefined ? { subagentContext } : {}),
    });

  it.each([
    ["no context", undefined],
    ["an empty context (the CI-fix route)", ""],
    ["a blank context", "  \n"],
  ])("adds no SubagentStart hook for %s", (_case, subagentContext) => {
    expect(withContext(subagentContext).hooks).not.toHaveProperty("SubagentStart");
  });

  it("hands every subagent type the context verbatim, in the hook-output JSON form, through sh", () => {
    const context = `All CI jobs have passed: 3/3. Don't re-run it; $(touch /tmp/x) \`id\` "quoted" \\n stays literal.`;
    const entries = withContext(context).hooks.SubagentStart ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("matcher");
    const output = execFileSync("sh", ["-c", entries[0]!.hooks[0]!.command], {
      encoding: "utf-8",
    });
    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: context },
    });
  });
});
