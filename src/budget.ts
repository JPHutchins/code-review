// Deterministic budget discipline for a headless review agent (issue #38). Two Claude Code hooks
// wired from ONE self-dispatching command: a PostToolBatch signal that steers the agent to converge
// as spend or wall-clock crosses a soft threshold, and a PreToolUse gate that, past a hard threshold,
// denies every tool except the convergence path — writing and validating the draft — so the agent
// produces its deliverable before the budget is gone rather than investigating until it is killed.
//
// Every decision here is pure. The CLI (index.ts) owns the impure edges — reading the transcript to
// measure spend, `Date.now()` for elapsed — and hands the results in as `BudgetParams`; the hook
// itself never crashes (index.ts degrades any failure to an empty, allow-everything result).

import { resolve } from "node:path";
import { shellQuote } from "./stop-gate.js";

const asRecord = (u: unknown): Record<string, unknown> | null =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : null;

/** The two budget axes, as fractions of their limits, that drive a decision. Either may be unknown
 *  (`spentUsd`/`budgetUsd` null when there is no price map to measure spend; `elapsedMs`/`wallMs`
 *  null when there is no wall set or no transcript timestamp), in which case only the other drives;
 *  if neither is known the phase is always `ok`. Crucially, unmeasurable spend is `null`, never 0 —
 *  telling the agent "$0.00 spent" when we simply can't measure would be misleading. */
export interface BudgetInputs {
  readonly spentUsd: number | null;
  readonly budgetUsd: number | null;
  readonly elapsedMs: number | null;
  readonly wallMs: number | null;
  readonly softFrac: number;
  readonly hardFrac: number;
}

/** How close the run is to its budget: `soft` → steer toward converging; `hard` → force it. The
 *  `fraction` is the driving (larger) axis, carried for the message. */
export type BudgetPhase =
  | { readonly kind: "ok" }
  | { readonly kind: "soft"; readonly fraction: number }
  | { readonly kind: "hard"; readonly fraction: number };

const costFraction = (i: BudgetInputs): number | null =>
  i.spentUsd !== null && i.budgetUsd !== null && i.budgetUsd > 0 ? i.spentUsd / i.budgetUsd : null;

const timeFraction = (i: BudgetInputs): number | null =>
  i.wallMs !== null && i.wallMs > 0 && i.elapsedMs !== null ? i.elapsedMs / i.wallMs : null;

/** The further-along of the two axes drives, so hitting EITHER the money OR the time limit converges
 *  the agent — matching the design's "judge on time and/or budget". Null when neither is measurable. */
const drivingFraction = (i: BudgetInputs): number | null => {
  const known = [costFraction(i), timeFraction(i)].filter((f): f is number => f !== null);
  return known.length === 0 ? null : Math.max(...known);
};

export const decideBudget = (i: BudgetInputs): BudgetPhase => {
  const frac = drivingFraction(i);
  if (frac === null) return { kind: "ok" };
  if (frac >= i.hardFrac) return { kind: "hard", fraction: frac };
  if (frac >= i.softFrac) return { kind: "soft", fraction: frac };
  return { kind: "ok" };
};

const pct = (n: number): string => `${String(Math.round(n * 100))}%`;
const money = (n: number): string => `$${n.toFixed(2)}`;
const mins = (ms: number): string => `${(ms / 60_000).toFixed(1)}m`;

const spendClause = (i: BudgetInputs): string | null =>
  i.spentUsd === null
    ? null
    : i.budgetUsd !== null && i.budgetUsd > 0
      ? `spent ${money(i.spentUsd)}/${money(i.budgetUsd)} (${pct(i.spentUsd / i.budgetUsd)})`
      : `spent ${money(i.spentUsd)}`;

const timeClause = (i: BudgetInputs): string | null =>
  i.elapsedMs === null
    ? null
    : i.wallMs !== null && i.wallMs > 0
      ? `${mins(i.elapsedMs)}/${mins(i.wallMs)} elapsed (${pct(i.elapsedMs / i.wallMs)})`
      : `${mins(i.elapsedMs)} elapsed`;

const directive = (phase: Exclude<BudgetPhase, { kind: "ok" }>, draftPath: string): string =>
  phase.kind === "hard"
    ? `Budget nearly exhausted — STOP all new investigation now. Write your COMPLETE findings to ${draftPath} and run \`code-review validate ${draftPath}\` until it passes. Other tools are blocked until that draft is written.`
    : `Wind down investigation and write your COMPLETE findings to ${draftPath} now, then validate — you may run out of budget before you finish otherwise.`;

/** The steer/deny message: both budget axes, then the phase's directive. Shown to the agent as
 *  PostToolBatch `additionalContext` (soft/hard) and as the PreToolUse deny reason (hard). */
export const budgetMessage = (
  i: BudgetInputs,
  phase: Exclude<BudgetPhase, { kind: "ok" }>,
  draftPath: string,
): string => {
  const status = [spendClause(i), timeClause(i)].filter((c): c is string => c !== null).join(" · ");
  return `Budget check — ${status}. ${directive(phase, draftPath)}`;
};

const targetsPath = (toolInput: unknown, draftPath: string): boolean => {
  const fp = asRecord(toolInput)?.["file_path"];
  return typeof fp === "string" && resolve(fp) === resolve(draftPath);
};

const invokesCodeReview = (toolInput: unknown): boolean => {
  const cmd = asRecord(toolInput)?.["command"];
  return typeof cmd === "string" && /\bcode-review\b/.test(cmd);
};

/** The tools left open during forced (hard-phase) convergence: reading anything (to synthesize),
 *  writing/editing ONLY the draft, and running the CLI itself (to validate). Everything else — new
 *  investigation, and crucially new `Agent`/`Task` subagent spawns — is denied. This is not a blind
 *  fan-out count-cap: cheap concurrency runs free early; spawns are clamped only once the budget is
 *  nearly spent (issue #38). */
export const isConvergenceTool = (
  toolName: string,
  toolInput: unknown,
  draftPath: string,
): boolean => {
  switch (toolName) {
    case "Read":
      return true;
    case "Write":
    case "Edit":
      return targetsPath(toolInput, draftPath);
    case "Bash":
      return invokesCodeReview(toolInput);
    default:
      return false;
  }
};

/** Everything the hook needs beyond the raw hook input: the measured spend/elapsed (gathered by the
 *  CLI from the transcript + clock) and the limits/draft from the wired flags. */
export interface BudgetParams {
  readonly spentUsd: number | null;
  readonly budgetUsd: number | null;
  readonly elapsedMs: number | null;
  readonly wallMs: number | null;
  readonly softFrac: number;
  readonly hardFrac: number;
  readonly draftPath: string;
}

/** Decide the hook output from the raw hook input + measured params, self-dispatching on the
 *  `hook_event_name` the input carries. Returns the exact object to print: `{}` is the universal
 *  no-op (allow / no steer). Pure — the CLI feeds it `params` and prints the result verbatim. */
export const evaluateBudgetHook = (
  input: unknown,
  params: BudgetParams,
): Record<string, unknown> => {
  const rec = asRecord(input);
  const inputs: BudgetInputs = {
    spentUsd: params.spentUsd,
    budgetUsd: params.budgetUsd,
    elapsedMs: params.elapsedMs,
    wallMs: params.wallMs,
    softFrac: params.softFrac,
    hardFrac: params.hardFrac,
  };
  const phase = decideBudget(inputs);

  switch (rec?.["hook_event_name"]) {
    case "PostToolBatch":
      return phase.kind === "ok"
        ? {}
        : {
            hookSpecificOutput: {
              hookEventName: "PostToolBatch",
              additionalContext: budgetMessage(inputs, phase, params.draftPath),
            },
          };
    case "PreToolUse": {
      if (phase.kind !== "hard") return {};
      const toolName = rec["tool_name"];
      if (
        typeof toolName === "string" &&
        isConvergenceTool(toolName, rec["tool_input"], params.draftPath)
      )
        return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: budgetMessage(inputs, phase, params.draftPath),
        },
      };
    }
    default:
      return {};
  }
};

/** Parse a wall-clock duration (`20m`, `1200s`, `2h`, `500ms`, or a bare number of seconds — matching
 *  the `timeout` convention the review job already uses). Null when unparseable, so the caller drops
 *  the time axis rather than trusting a garbage limit. */
export const parseWallMs = (raw: string): number | null => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (m === null) return null;
  const [, num = "", unit = "s"] = m;
  const n = Number.parseFloat(num);
  if (!Number.isFinite(n)) return null;
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    default:
      return n * 3_600_000;
  }
};

/** Parse a fraction in (0, 1]; fall back to `fallback` on anything unparseable or out of range, so a
 *  malformed flag never disables or inverts the gate — it just uses the default threshold. */
export const parseFraction = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
};

/** The default budget-hook command: this CLI re-invoked, carrying the limits so the hook decides
 *  exactly as the caller intended. The SAME string is wired to both PreToolUse and PostToolBatch —
 *  it self-dispatches on the event it reads from stdin. */
export const budgetHookCommand = (
  draftPath: string,
  opts: {
    readonly budgetUsd?: string;
    readonly wall?: string;
    readonly prices?: string;
    readonly softFrac?: string;
    readonly hardFrac?: string;
  },
): string =>
  [
    "code-review budget-hook --draft",
    shellQuote(draftPath),
    ...(opts.budgetUsd ? ["--budget-usd", shellQuote(opts.budgetUsd)] : []),
    ...(opts.wall ? ["--wall", shellQuote(opts.wall)] : []),
    ...(opts.prices ? ["--prices", shellQuote(opts.prices)] : []),
    ...(opts.softFrac ? ["--soft-frac", shellQuote(opts.softFrac)] : []),
    ...(opts.hardFrac ? ["--hard-frac", shellQuote(opts.hardFrac)] : []),
  ].join(" ");
