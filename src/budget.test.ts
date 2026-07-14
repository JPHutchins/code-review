import { describe, it, expect } from "vitest";
import {
  decideBudget,
  blockedDuringConvergence,
  budgetMessage,
  writesToDraft,
  singleWriterMessage,
  spawnFloorMessage,
  forceBackgroundSpawn,
  mainHasWrittenDraft,
  seedMarkerPath,
  evaluateBudgetHook,
  parseWallMs,
  parseFraction,
  parseEpochSecMs,
  anchoredElapsedMs,
  deadlineEpochSec,
  budgetHookCommand,
  type BudgetInputs,
  type BudgetParams,
  type ReserveParams,
} from "./budget.js";

// Flat reserves default to 0 and growth to 0 here so the base fraction alone drives — the flat-floor
// and progressive-growth behaviours are exercised by their own tests below.
const inputs = (o: Partial<BudgetInputs>): BudgetInputs => ({
  spentUsd: null,
  budgetUsd: null,
  elapsedMs: null,
  wallMs: null,
  reserve: { frac: 0.15, growth: 0, flatUsd: 0, flatMs: 0 },
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

  it("stays hard once past the budget wall (the grace window between the budget wall and the hard kill)", () => {
    // elapsed > wall: the review job runs the agent a few minutes past AGENT_WALL under continuous
    // over-budget pressure before `timeout` kills it — the hook must keep forcing convergence here.
    expect(decideBudget(inputs({ elapsedMs: 720_000, wallMs: 600_000 })).kind).toBe("hard");
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
    const r = { frac: 0.15, growth: 0, flatUsd: 0.02, flatMs: 120_000 };
    expect(decideBudget(inputs({ elapsedMs: 5_000, wallMs: 60_000, reserve: r })).kind).toBe(
      "hard",
    );
    // $0.05 budget, $0.02 flat: soft once < $0.04 remains, hard once < $0.02 remains.
    expect(decideBudget(inputs({ spentUsd: 0.02, budgetUsd: 0.05, reserve: r })).kind).toBe("soft");
    expect(decideBudget(inputs({ spentUsd: 0.04, budgetUsd: 0.05, reserve: r })).kind).toBe("hard");
  });

  describe("progressive reserve (growth) converges earlier the longer the run has gone (issue #45)", () => {
    const g = (frac: number, growth: number): ReserveParams => ({
      frac,
      growth,
      flatUsd: 0,
      flatMs: 0,
    });
    const at = (elapsedMs: number, growth: number) =>
      decideBudget(inputs({ elapsedMs, wallMs: 1000, reserve: g(0.15, growth) })).kind;

    it("escalates a mid-run point one tier vs the flat reserve", () => {
      // Flat (growth 0): 500/1000 is still ok, 700/1000 is only soft.
      expect(at(500, 0)).toBe("ok");
      expect(at(700, 0)).toBe("soft");
      // Growth 0.25: the SAME points are one tier more severe — the run converges sooner.
      expect(at(500, 0.25)).toBe("soft");
      expect(at(700, 0.25)).toBe("hard");
    });

    it("growth 0 recovers the flat reserve exactly (hard once < frac remains)", () => {
      expect(at(840, 0)).toBe("soft");
      expect(at(850, 0)).toBe("hard");
    });

    it("scales with usage on the cost axis too, not just time", () => {
      // frac 0.15 + growth 0.25 → hard once spent ≥ ~0.68 of a $1 budget (vs only soft when flat).
      expect(
        decideBudget(inputs({ spentUsd: 0.72, budgetUsd: 1, reserve: g(0.15, 0.25) })).kind,
      ).toBe("hard");
      expect(decideBudget(inputs({ spentUsd: 0.72, budgetUsd: 1, reserve: g(0.15, 0) })).kind).toBe(
        "soft",
      );
    });
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

describe("writesToDraft (single-writer detection)", () => {
  const d = "/work/findings-draft.json";
  it("matches file-writing tools targeting the draft (abs path or basename); NotebookEdit via notebook_path", () => {
    expect(writesToDraft("Write", { file_path: d }, d)).toBe(true);
    expect(writesToDraft("Edit", { file_path: d }, d)).toBe(true);
    expect(writesToDraft("MultiEdit", { file_path: d }, d)).toBe(true);
    expect(writesToDraft("Write", { file_path: "findings-draft.json" }, d)).toBe(true);
    expect(writesToDraft("NotebookEdit", { notebook_path: d }, d)).toBe(true);
  });
  it("matches Bash redirects, heredocs, and every tee variant into the draft — including the $DRAFT token", () => {
    expect(writesToDraft("Bash", { command: `echo '{}' > ${d}` }, d)).toBe(true);
    expect(writesToDraft("Bash", { command: `printf x >>${d}` }, d)).toBe(true);
    expect(writesToDraft("Bash", { command: `cat > ${d} <<'EOF'\n{}\nEOF` }, d)).toBe(true);
    expect(writesToDraft("Bash", { command: `echo x | tee -a ${d}` }, d)).toBe(true);
    expect(writesToDraft("Bash", { command: `echo x | tee --append ${d}` }, d)).toBe(true);
    expect(writesToDraft("Bash", { command: `echo x | tee -ai ${d}` }, d)).toBe(true);
    expect(writesToDraft("Bash", { command: 'echo x > "$DRAFT"' }, d)).toBe(true);
  });
  it("does NOT match reads of the draft (only mutation races the single writer)", () => {
    expect(writesToDraft("Bash", { command: `cat ${d}` }, d)).toBe(false);
    expect(writesToDraft("Bash", { command: `code-review validate ${d}` }, d)).toBe(false);
    expect(writesToDraft("Read", { file_path: d }, d)).toBe(false);
  });
  it("does NOT match writes to OTHER files", () => {
    expect(writesToDraft("Write", { file_path: "/work/other.json" }, d)).toBe(false);
    expect(writesToDraft("Bash", { command: "echo x > /tmp/scratch.txt" }, d)).toBe(false);
  });
  it("only inspects `command` for Bash — a non-shell tool carrying a `command` field is not a draft write", () => {
    expect(writesToDraft("SomeMcpTool", { command: `> ${d}` }, d)).toBe(false);
  });
});

describe("budgetMessage", () => {
  const draft = "/work/findings.json";
  it("reports both axes and the hard directive when hard (main agent: write the draft)", () => {
    const msg = budgetMessage(
      inputs({ spentUsd: 0.95, budgetUsd: 1, elapsedMs: 60_000, wallMs: 120_000 }),
      { kind: "hard" },
      draft,
      false,
    );
    expect(msg).toContain("$0.95/$1.00");
    expect(msg).toContain("elapsed");
    expect(msg).toContain("STOP all new investigation");
    expect(msg).toContain(`Write your COMPLETE findings from what you already have to ${draft}`);
    expect(msg).toContain("Do not wait for subagents still running in the background");
  });
  it("uses the softer directive when soft", () => {
    const msg = budgetMessage(
      inputs({ spentUsd: 0.75, budgetUsd: 1 }),
      { kind: "soft" },
      draft,
      false,
    );
    expect(msg).toContain("Wind down investigation");
    expect(msg).not.toContain("STOP all new investigation");
  });
  it("steers a SUBAGENT to report to the main agent, never to write the draft it cannot write", () => {
    const hardSub = budgetMessage(
      inputs({ spentUsd: 0.95, budgetUsd: 1 }),
      { kind: "hard" },
      draft,
      true,
    );
    expect(hardSub).toContain("report the findings you have back to the main agent");
    expect(hardSub).toContain(`Do not write ${draft}`);
    expect(hardSub).not.toContain(`Write your COMPLETE findings to ${draft}`);
    const softSub = budgetMessage(
      inputs({ spentUsd: 0.75, budgetUsd: 1 }),
      { kind: "soft" },
      draft,
      true,
    );
    expect(softSub).toContain("report the findings you have back to the main agent");
    expect(softSub).not.toContain("STOP all new investigation");
  });
  it("renders an over-budget (past-deadline) time clause as >100% without breaking", () => {
    const msg = budgetMessage(
      inputs({ elapsedMs: 720_000, wallMs: 600_000 }),
      { kind: "hard" },
      draft,
      false,
    );
    expect(msg).toContain("12.0m/10.0m elapsed (120%)");
  });
  it("omits the time clause when elapsed is unknown, and the denominator when budget is unknown", () => {
    const msg = budgetMessage(inputs({ spentUsd: 0.5 }), { kind: "soft" }, draft, false);
    expect(msg).toContain("spent $0.50");
    expect(msg).not.toContain("/$");
    expect(msg).not.toContain("elapsed");
  });
  it("omits the spend clause (never '$0.00') when spend is unmeasurable, showing only time", () => {
    const msg = budgetMessage(
      inputs({ spentUsd: null, elapsedMs: 60_000, wallMs: 120_000 }),
      { kind: "soft" },
      draft,
      false,
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
    reserve: { frac: 0.15, growth: 0, flatUsd: 0, flatMs: 0 },
    draftPath: draft,
    mainDraftWritten: true,
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

  it("PreToolUse: allows a non-spawn tool below hard (soft does not deny; spawns are handled separately)", () => {
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

  // Single-writer enforcement: a fan-out subagent (agent_id present) may never write the draft; only
  // the main agent (no agent_id) writes it. Independent of budget phase — denied even at ok.
  const denySub = (tool_input: Record<string, unknown>, tool_name: string, p = ok) =>
    evaluateBudgetHook(
      { hook_event_name: "PreToolUse", agent_id: "a1b2c3", tool_name, tool_input },
      p,
    ) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };

  it("PreToolUse: denies a SUBAGENT writing the draft — Write tool — at any phase", () => {
    const out = denySub({ file_path: draft }, "Write");
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBe(singleWriterMessage(draft));
  });
  it("PreToolUse: denies a SUBAGENT writing the draft — Bash redirect and heredoc", () => {
    expect(
      denySub({ command: `echo '{}' > ${draft}` }, "Bash").hookSpecificOutput?.permissionDecision,
    ).toBe("deny");
    expect(
      denySub({ command: `cat > ${draft} <<'EOF'\n{}\nEOF` }, "Bash").hookSpecificOutput
        ?.permissionDecision,
    ).toBe("deny");
    expect(
      denySub({ command: `echo x >> ${draft}` }, "Bash").hookSpecificOutput?.permissionDecision,
    ).toBe("deny");
  });
  it("PreToolUse: does NOT deny the MAIN agent writing the draft (no agent_id) — it is the sole writer", () => {
    expect(
      evaluateBudgetHook(
        { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: draft } },
        ok,
      ),
    ).toEqual({});
  });
  it("PreToolUse: does NOT deny a subagent READING/validating the draft (only mutation races)", () => {
    expect(denySub({ command: `cat ${draft}` }, "Bash")).toEqual({});
    expect(denySub({ command: `code-review validate ${draft}` }, "Bash")).toEqual({});
    expect(denySub({ file_path: draft }, "Read")).toEqual({});
  });
  it("PreToolUse: a subagent draft-write deny fires even under hard budget (both apply; single-writer first)", () => {
    expect(
      denySub({ file_path: draft }, "Write", hard).hookSpecificOutput?.permissionDecisionReason,
    ).toBe(singleWriterMessage(draft));
  });
  it("PreToolUse: still forces convergence on the time axis when spend is unmeasurable", () => {
    const out = evaluateBudgetHook(
      { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: {} },
      params({ spentUsd: null, elapsedMs: 950, wallMs: 1000 }),
    ) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).not.toContain("$");
  });

  // Fan-out discipline: below hard, the main agent's spawns are gated on its own first-pass draft,
  // and every permitted spawn — Agent or Task, main's or a subagent's — is rewritten to run in the
  // background so no batch join can block the spawner where hooks cannot reach it.
  const spawn = (p: BudgetParams, extra: Record<string, unknown> = {}) =>
    evaluateBudgetHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { prompt: "hunt", model: "flash" },
        ...extra,
      },
      p,
    ) as {
      hookSpecificOutput: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
        updatedInput?: Record<string, unknown>;
      };
    };

  it("PreToolUse: rewrites the MAIN agent's spawn to run_in_background, preserving its input", () => {
    const out = spawn(ok);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput).toEqual({
      prompt: "hunt",
      model: "flash",
      run_in_background: true,
    });
  });
  it("PreToolUse: the rewrite overrides an explicit run_in_background: false", () => {
    const out = evaluateBudgetHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { prompt: "hunt", run_in_background: false },
      },
      ok,
    ) as { hookSpecificOutput: { updatedInput: Record<string, unknown> } };
    expect(out.hookSpecificOutput.updatedInput["run_in_background"]).toBe(true);
  });
  it("PreToolUse: denies the MAIN agent's spawn until its own draft exists (seed does not count)", () => {
    const out = spawn(params({ ...ok, mainDraftWritten: false }));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(spawnFloorMessage(draft));
  });
  it("PreToolUse: a SUBAGENT's spawn is not floor-gated — rewritten to background regardless", () => {
    const out = spawn(params({ ...ok, mainDraftWritten: false }), { agent_id: "a1b2c3" });
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput?.["run_in_background"]).toBe(true);
  });
  it("PreToolUse: the hard-phase spawn deny wins over the background rewrite", () => {
    const out = spawn(hard);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("STOP all new investigation");
  });
  it("PreToolUse: non-spawn tools are never rewritten", () => {
    expect(
      evaluateBudgetHook(
        { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } },
        params({ ...ok, mainDraftWritten: false }),
      ),
    ).toEqual({});
  });
  it("no-ops for an unknown event or a non-object input", () => {
    expect(evaluateBudgetHook({ hook_event_name: "SessionStart" }, hard)).toEqual({});
    expect(evaluateBudgetHook(null, hard)).toEqual({});
    expect(evaluateBudgetHook("not-json", hard)).toEqual({});
  });
});

describe("mainHasWrittenDraft (fan-out floor)", () => {
  it("false while the draft does not exist", () => {
    expect(mainHasWrittenDraft(null, null)).toBe(false);
    expect(mainHasWrittenDraft(null, 1000)).toBe(false);
  });
  it("true for any existing draft when no seed marker exists (no seeding ran)", () => {
    expect(mainHasWrittenDraft(1000, null)).toBe(true);
  });
  it("only a draft modified AFTER the marker counts — the untouched seed does not", () => {
    // seed-draft writes the draft first, then the marker, so an untouched seed's mtime is ≤ the
    // marker's; any later agent write moves the draft's mtime past it.
    expect(mainHasWrittenDraft(1000, 1000)).toBe(false);
    expect(mainHasWrittenDraft(999, 1000)).toBe(false);
    expect(mainHasWrittenDraft(1001, 1000)).toBe(true);
  });
});

describe("seedMarkerPath", () => {
  it("derives the sidecar beside the draft (the seed-draft ↔ budget-hook convention)", () => {
    expect(seedMarkerPath("/work/findings-draft.json")).toBe("/work/findings-draft.json.seed");
  });
});

describe("forceBackgroundSpawn", () => {
  it("is a PreToolUse allow carrying the original input plus run_in_background: true", () => {
    expect(forceBackgroundSpawn({ prompt: "hunt" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { prompt: "hunt", run_in_background: true },
      },
    });
  });
  it("degrades a non-object input to just the background flag rather than crashing", () => {
    expect(forceBackgroundSpawn(undefined)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { run_in_background: true },
      },
    });
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

describe("parseEpochSecMs", () => {
  it("parses a bare positive integer of epoch SECONDS to epoch ms", () => {
    expect(parseEpochSecMs("1700000000")).toBe(1_700_000_000_000);
    expect(parseEpochSecMs("  1700000000  ")).toBe(1_700_000_000_000);
  });
  it("returns null for unset, non-integer, zero/negative, or exponent forms (no garbage anchor)", () => {
    expect(parseEpochSecMs(undefined)).toBeNull();
    expect(parseEpochSecMs("")).toBeNull();
    expect(parseEpochSecMs("abc")).toBeNull();
    expect(parseEpochSecMs("12.5")).toBeNull();
    expect(parseEpochSecMs("0")).toBeNull();
    expect(parseEpochSecMs("-5")).toBeNull();
    expect(parseEpochSecMs("17e9")).toBeNull();
    expect(parseEpochSecMs("100abc")).toBeNull();
  });
});

describe("anchoredElapsedMs", () => {
  it("uses the absolute anchor when present: elapsed = wall − (deadline − now)", () => {
    // deadline 100s out on a 600s wall → 500s elapsed, regardless of any transcript timestamp.
    expect(
      anchoredElapsedMs({
        deadlineMs: 1_000_000 + 100_000,
        wallMs: 600_000,
        firstTsMs: null,
        nowMs: 1_000_000,
      }),
    ).toBe(500_000);
  });

  it("issue #45: the anchor WINS over a fresh subagent's ≈0 firstTsMs (the fan-out-blindness fix)", () => {
    // A subagent's own transcript started 1s ago — firstTsMs alone would read 1s elapsed (≈0%, no
    // steer). The shared anchor says the run is 500s into its 600s wall — that must be what drives.
    const elapsed = anchoredElapsedMs({
      deadlineMs: 1_000_000 + 100_000,
      wallMs: 600_000,
      firstTsMs: 1_000_000 - 1_000,
      nowMs: 1_000_000,
    });
    expect(elapsed).toBe(500_000);
    expect(elapsed).not.toBe(1_000);
  });

  it("falls back to the per-transcript start when no anchor (or no wall) is set", () => {
    expect(
      anchoredElapsedMs({
        deadlineMs: null,
        wallMs: 600_000,
        firstTsMs: 970_000,
        nowMs: 1_000_000,
      }),
    ).toBe(30_000);
    // deadline set but no wall → can't anchor → transcript fallback
    expect(
      anchoredElapsedMs({
        deadlineMs: 1_100_000,
        wallMs: null,
        firstTsMs: 970_000,
        nowMs: 1_000_000,
      }),
    ).toBe(30_000);
  });

  it("is null when neither the anchor nor a transcript start is knowable (time axis disabled)", () => {
    expect(
      anchoredElapsedMs({ deadlineMs: null, wallMs: 600_000, firstTsMs: null, nowMs: 1_000_000 }),
    ).toBeNull();
  });

  it("clamps to ≥ 0 — a deadline further out than the wall (clock skew) never reads negative", () => {
    expect(
      anchoredElapsedMs({
        deadlineMs: 1_000_000 + 700_000, // 700s out on a 600s wall
        wallMs: 600_000,
        firstTsMs: null,
        nowMs: 1_000_000,
      }),
    ).toBe(0);
  });
});

describe("deadlineEpochSec", () => {
  it("is now (floored to seconds) + the wall (ceiled to seconds)", () => {
    expect(deadlineEpochSec(600_000, 1_000_000)).toBe(1_600);
    // now rounds DOWN, wall rounds UP — the anchor never expires before the matching timeout kill
    expect(deadlineEpochSec(90_500, 1_000_499)).toBe(1_000 + 91);
  });
});

describe("budgetHookCommand", () => {
  it("re-invokes the CLI with the draft and only the flags that are set", () => {
    const cmd = budgetHookCommand("/work/findings.json", {
      budgetUsd: "2.5",
      wall: "20m",
      reserveGrowth: "0.3",
    });
    expect(cmd).toContain("code-review budget-hook --draft '/work/findings.json'");
    expect(cmd).toContain("--budget-usd '2.5'");
    expect(cmd).toContain("--wall '20m'");
    expect(cmd).toContain("--reserve-growth '0.3'");
    expect(cmd).not.toContain("--prices");
    expect(cmd).not.toContain("--soft-frac");
  });
});
