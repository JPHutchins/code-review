// Deterministic budget discipline for a headless review agent (issue #38). Two Claude Code hooks
// wired from ONE self-dispatching command: a PostToolBatch signal that steers the agent to converge
// once spend or wall-clock enters its soft wind-down reserve, and a PreToolUse gate that, inside the
// smaller hard reserve, denies the budget-burning tools — subagent spawns, arbitrary shell, web —
// while leaving the deliver-the-draft path open, so the agent produces its review before the budget
// is gone rather than investigating until it is killed.
//
// Every decision here is pure. The CLI (index.ts) owns the impure edges — reading the transcript to
// measure spend, `Date.now()` for elapsed — and hands the results in as `BudgetParams`; the hook
// itself never crashes (index.ts degrades any failure to an empty, allow-everything result).

import { shellQuote } from "./stop-gate.js";
import { asRecord } from "./util.js";

/** The two budget axes and the wind-down reserve to judge them against. Either axis may be unknown
 *  (`spentUsd`/`budgetUsd` null when there is no price map to measure spend; `elapsedMs`/`wallMs`
 *  null when there is no wall set or no transcript timestamp), in which case only the other drives;
 *  if neither is known the phase is always `ok`. Crucially, unmeasurable spend is `null`, never 0 —
 *  telling the agent "$0.00 spent" when we simply can't measure would be misleading. */
export interface BudgetInputs {
  readonly spentUsd: number | null;
  readonly budgetUsd: number | null;
  readonly elapsedMs: number | null;
  readonly wallMs: number | null;
  readonly reserve: ReserveParams;
}

/** The headroom to hold back for wind-down, judged per axis as max(flat floor, `frac` × the budget):
 *  the flat floor keeps a tiny budget from converging with no absolute room left to write and validate
 *  the draft, while the fraction lets a large budget scale. The soft (steer) tier reserves
 *  SOFT_MULTIPLE× the hard (force) tier, so the agent is nudged to converge with a whole extra reserve
 *  still in hand rather than only at the brink (issue #38). */
export interface ReserveParams {
  readonly frac: number;
  readonly flatUsd: number;
  readonly flatMs: number;
}

/** Defaults sized for real reviews: hold back 15% of the budget, but never less than $0.02 / 2 minutes
 *  of absolute wind-down room. On a large budget the fraction dominates (≈ the old 0.7/0.85 soft/hard
 *  behaviour); on a tiny one the flat floor dominates and converges the agent at once. */
export const DEFAULT_RESERVE: ReserveParams = { frac: 0.15, flatUsd: 0.02, flatMs: 120_000 };

const SOFT_MULTIPLE = 2;

/** How close the run is to its budget: `soft` → steer toward converging; `hard` → force it. */
export type BudgetPhase =
  { readonly kind: "ok" } | { readonly kind: "soft" } | { readonly kind: "hard" };

interface Axis {
  readonly used: number;
  readonly limit: number;
  readonly flat: number;
}

const costAxis = (i: BudgetInputs): Axis | null =>
  i.spentUsd !== null && i.budgetUsd !== null && i.budgetUsd > 0
    ? { used: i.spentUsd, limit: i.budgetUsd, flat: i.reserve.flatUsd }
    : null;

const timeAxis = (i: BudgetInputs): Axis | null =>
  i.elapsedMs !== null && i.wallMs !== null && i.wallMs > 0
    ? { used: i.elapsedMs, limit: i.wallMs, flat: i.reserve.flatMs }
    : null;

/** 2 = inside the hard reserve (force convergence), 1 = inside the soft reserve (steer), 0 = ok. The
 *  hard reserve is max(flat floor, frac × limit); the soft reserve is SOFT_MULTIPLE× the hard one. */
const axisSeverity = (a: Axis, frac: number): 0 | 1 | 2 => {
  const hardReserve = Math.max(a.flat, frac * a.limit);
  const remaining = a.limit - a.used;
  if (remaining <= hardReserve) return 2;
  if (remaining <= SOFT_MULTIPLE * hardReserve) return 1;
  return 0;
};

/** Converge as the run nears EITHER budget: the most-severe axis drives, so exhausting the money OR
 *  the time reserve steers/forces the agent — matching the design's "judge on time and/or budget".
 *  `ok` when neither axis is measurable. */
export const decideBudget = (i: BudgetInputs): BudgetPhase => {
  const worst = [costAxis(i), timeAxis(i)]
    .filter((a): a is Axis => a !== null)
    .reduce<0 | 1 | 2>((max, a) => Math.max(max, axisSeverity(a, i.reserve.frac)) as 0 | 1 | 2, 0);
  return worst === 2 ? { kind: "hard" } : worst === 1 ? { kind: "soft" } : { kind: "ok" };
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

const invokesCodeReviewValidate = (toolInput: unknown): boolean => {
  const cmd = asRecord(toolInput)?.["command"];
  // `validate` must not be a prefix of another subcommand — `\b` alone matches before the hyphen in
  // `validate-patches` (a findings-mutating command that must NOT pass the gate), so exclude `-`/word.
  return typeof cmd === "string" && /\bcode-review\s+validate(?![\w-])/.test(cmd);
};

const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const WEB_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);

/** Under hard-phase forced convergence, block ONLY the tools that spend budget on new work —
 *  subagent spawns (the #38 fan-out), arbitrary shell, and web calls — and allow everything else. A
 *  denylist, not an allowlist: the tools that DELIVER the finished review (writing/validating the
 *  draft, and whatever terminal tool the agent uses to return its answer) must never be blocked from
 *  finishing — a live dogfood showed an allowlist denying the answer tool and stranding a complete
 *  draft (issue #38). `Bash` is the one carve-out, permitted solely to run `code-review validate`. */
export const blockedDuringConvergence = (toolName: string, toolInput: unknown): boolean => {
  if (SPAWN_TOOLS.has(toolName) || WEB_TOOLS.has(toolName)) return true;
  if (toolName === "Bash") return !invokesCodeReviewValidate(toolInput);
  return false;
};

/** Everything the hook needs beyond the raw hook input: the measured spend/elapsed (gathered by the
 *  CLI from the transcript + clock) and the limits/draft from the wired flags. */
export interface BudgetParams {
  readonly spentUsd: number | null;
  readonly budgetUsd: number | null;
  readonly elapsedMs: number | null;
  readonly wallMs: number | null;
  readonly reserve: ReserveParams;
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
    reserve: params.reserve,
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
      if (typeof toolName === "string" && blockedDuringConvergence(toolName, rec["tool_input"]))
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: budgetMessage(inputs, phase, params.draftPath),
          },
        };
      return {};
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

/** Parse a fraction in [0, 1]; fall back to `fallback` on anything unparseable or out of range. `0`
 *  is valid and meaningful — it disables the fraction part of the reserve so only the flat floor
 *  applies. A malformed flag never inverts the gate; it just uses the default. */
export const parseFraction = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
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
    readonly reserveFrac?: string;
    readonly reserveUsd?: string;
    readonly reserveWall?: string;
  },
): string =>
  [
    "code-review budget-hook --draft",
    shellQuote(draftPath),
    ...(opts.budgetUsd ? ["--budget-usd", shellQuote(opts.budgetUsd)] : []),
    ...(opts.wall ? ["--wall", shellQuote(opts.wall)] : []),
    ...(opts.prices ? ["--prices", shellQuote(opts.prices)] : []),
    ...(opts.reserveFrac ? ["--reserve-frac", shellQuote(opts.reserveFrac)] : []),
    ...(opts.reserveUsd ? ["--reserve-usd", shellQuote(opts.reserveUsd)] : []),
    ...(opts.reserveWall ? ["--reserve-wall", shellQuote(opts.reserveWall)] : []),
  ].join(" ");
