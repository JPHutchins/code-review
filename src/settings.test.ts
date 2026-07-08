import { describe, it, expect } from "vitest";
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
