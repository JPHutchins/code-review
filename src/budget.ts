// Pure — the CLI (index.ts) owns IO and degrades any error to an allow-everything no-op.

import { basename, dirname, extname, join } from "node:path";

import { shellQuote } from "./stop-gate.js";
import { asRecord } from "./util.js";

export const DEADLINE_ENV = "CODE_REVIEW_DEADLINE_EPOCH";

export interface BudgetInputs {
  // Unmeasurable spend is null, never 0 — never tell the agent "$0.00 spent".
  readonly spentUsd: number | null;
  readonly budgetUsd: number | null;
  readonly elapsedMs: number | null;
  readonly wallMs: number | null;
  readonly reserve: ReserveParams;
}

export interface ReserveParams {
  readonly frac: number;
  readonly growth: number;
  readonly flatUsd: number;
  readonly flatMs: number;
}

export const DEFAULT_RESERVE: ReserveParams = {
  frac: 0.15,
  growth: 0.25,
  flatUsd: 0.02,
  flatMs: 120_000,
};

const SOFT_MULTIPLE = 2;

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

const axisSeverity = (a: Axis, reserve: ReserveParams): 0 | 1 | 2 => {
  const usedFrac = Math.min(1, Math.max(0, a.used / a.limit));
  const effFrac = reserve.frac + reserve.growth * usedFrac;
  const hardReserve = Math.max(a.flat, effFrac * a.limit);
  const remaining = a.limit - a.used;
  if (remaining <= hardReserve) return 2;
  if (remaining <= SOFT_MULTIPLE * hardReserve) return 1;
  return 0;
};

export const decideBudget = (i: BudgetInputs): BudgetPhase => {
  const worst = [costAxis(i), timeAxis(i)]
    .filter((a): a is Axis => a !== null)
    .reduce<0 | 1 | 2>((max, a) => Math.max(max, axisSeverity(a, i.reserve)) as 0 | 1 | 2, 0);
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

// A subagent can't write the draft (single-writer deny below), so it is told to report back, not write.
const directive = (
  phase: Exclude<BudgetPhase, { kind: "ok" }>,
  draftPath: string,
  isSubagent: boolean,
): string => {
  if (isSubagent)
    return phase.kind === "hard"
      ? `Budget nearly exhausted — STOP all new investigation now and report the findings you have back to the main agent in your reply. Do not write ${draftPath} yourself; only the main agent writes it.`
      : `Wind down investigation and report the findings you have back to the main agent in your reply — do not write ${draftPath} yourself; the main agent writes it, and you may run out of budget otherwise.`;
  return phase.kind === "hard"
    ? `Budget nearly exhausted — STOP all new investigation now. Do not wait for subagents still running in the background. Write your COMPLETE findings from what you already have to ${draftPath} and run \`code-review validate ${draftPath} --explain\` until it passes (--explain prints the exact schema when the shape is wrong). Other tools are blocked until that draft is written.`
    : `Wind down investigation and write your COMPLETE findings to ${draftPath} now, then run \`code-review validate ${draftPath} --explain\` (it prints the exact schema if the shape is wrong) — fold in the subagent reports you already have rather than waiting on stragglers; you may run out of budget before you finish otherwise.`;
};

export const budgetMessage = (
  i: BudgetInputs,
  phase: Exclude<BudgetPhase, { kind: "ok" }>,
  draftPath: string,
  isSubagent: boolean,
): string => {
  const status = [spendClause(i), timeClause(i)].filter((c): c is string => c !== null).join(" · ");
  return `Budget check — ${status}. ${directive(phase, draftPath, isSubagent)}`;
};

const invokesCodeReviewValidate = (toolInput: unknown): boolean => {
  const cmd = asRecord(toolInput)?.["command"];
  // (?![\w-]) excludes validate-patches — a findings-mutating command that must not pass this gate.
  return typeof cmd === "string" && /\bcode-review\s+validate(?![\w-])/.test(cmd);
};

const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const WEB_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);

export const blockedDuringConvergence = (toolName: string, toolInput: unknown): boolean => {
  if (SPAWN_TOOLS.has(toolName) || WEB_TOOLS.has(toolName)) return true;
  if (toolName === "Bash") return !invokesCodeReviewValidate(toolInput);
  return false;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Scoped to the accidental fan-out race, not adversarial evasion (cp/mv/dd are out of scope).
export const writesToDraft = (toolName: string, toolInput: unknown, draftPath: string): boolean => {
  const rec = asRecord(toolInput);
  const targets = [draftPath, basename(draftPath), "$DRAFT", "${DRAFT}"];
  if (WRITE_TOOLS.has(toolName)) {
    const fp = rec?.["file_path"] ?? rec?.["notebook_path"];
    if (typeof fp === "string" && targets.some((t) => fp === t || basename(fp) === basename(t)))
      return true;
  }
  if (toolName === "Bash") {
    const cmd = rec?.["command"];
    if (typeof cmd !== "string") return false;
    const alt = targets.map(escapeRegExp).join("|");
    const end = "(?=$|[\\s|&;)])";
    const redirect = new RegExp(`>>?\\|?\\s*(['"]?)(?:${alt})\\1${end}`);
    const teeArg = new RegExp(`\\btee\\b(?:\\s+-{1,2}\\S+)*\\s+(['"]?)(?:${alt})\\1${end}`);
    return redirect.test(cmd) || teeArg.test(cmd);
  }
  return false;
};

// Agent-facing (ships to every user's review): no internal refs.
export const singleWriterMessage = (draftPath: string): string =>
  `Only the main agent may write ${draftPath}. When a subagent writes it too, the concurrent writers clobber each other and the review comes out empty. Do NOT write, edit, or redirect into ${draftPath} — instead, return the findings you discovered in your reply (the field names are in the schema); the main agent collects every subagent's reported findings and writes the draft itself.`;

// Written AFTER the seed so its mtime bounds the seed's; the convention is shared with mainHasWrittenDraft.
export const seedMarkerPath = (draftPath: string): string => `${draftPath}.seed`;

// Holds only ever a document that passed the extraction ladder: the budget hook snapshots the draft
// here whenever it validates, so a wall-kill that leaves the live draft truncated still recovers the
// last valid state (down to the seed) instead of posting "did not complete". The postfix goes before
// the extension so the snapshot keeps the draft's real type (findings-draft.last-valid.json).
export const lastValidPath = (draftPath: string): string => {
  const ext = extname(draftPath);
  return join(dirname(draftPath), `${basename(draftPath, ext)}.last-valid${ext}`);
};

// mtime, not content: a rewrite that reproduces the seed bytes still counts as agent-written.
export const mainHasWrittenDraft = (
  draftMtimeMs: number | null,
  seedMarkerMtimeMs: number | null,
): boolean =>
  draftMtimeMs !== null && (seedMarkerMtimeMs === null || draftMtimeMs > seedMarkerMtimeMs);

// Agent-facing: no internal refs.
export const spawnFloorMessage = (draftPath: string): string =>
  `Write your own first-pass findings to ${draftPath} before spawning subagents — a review must never depend on subagents alone, and a pre-seeded draft does not count until you have revised it yourself this run. Write ${draftPath} from what you have read so far (preliminary findings are fine), run \`code-review validate ${draftPath} --explain\` until it passes, then fan out; your subagents run in the background, so keep refining the draft as their reports arrive.`;

// Background so the spawner never blocks on a batch join, where no hook can reach it to steer.
export const forceBackgroundSpawn = (toolInput: unknown): Record<string, unknown> => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { ...(asRecord(toolInput) ?? {}), run_in_background: true },
  },
});

export interface BudgetParams {
  readonly spentUsd: number | null;
  readonly budgetUsd: number | null;
  readonly elapsedMs: number | null;
  readonly wallMs: number | null;
  readonly reserve: ReserveParams;
  readonly draftPath: string;
  readonly mainDraftWritten: boolean;
}

const denyPreTool = (reason: string): Record<string, unknown> => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

// A non-empty agent_id marks a fan-out subagent; the main agent has none (or ""). The one predicate
// every consumer shares, so the snapshot gate and the single-writer deny never disagree on "".
export const isSubagentHookInput = (input: unknown): boolean => {
  const agentId = asRecord(input)?.["agent_id"];
  return typeof agentId === "string" && agentId.length > 0;
};

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
  const isSubagent = isSubagentHookInput(input);

  switch (rec?.["hook_event_name"]) {
    case "PostToolBatch":
      return phase.kind === "ok"
        ? {}
        : {
            hookSpecificOutput: {
              hookEventName: "PostToolBatch",
              additionalContext: budgetMessage(inputs, phase, params.draftPath, isSubagent),
            },
          };
    case "PreToolUse": {
      const toolName = rec["tool_name"];
      if (typeof toolName !== "string") return {};
      // Single-writer enforcement is independent of budget phase.
      if (isSubagent && writesToDraft(toolName, rec["tool_input"], params.draftPath))
        return denyPreTool(singleWriterMessage(params.draftPath));
      if (phase.kind === "hard" && blockedDuringConvergence(toolName, rec["tool_input"]))
        return denyPreTool(budgetMessage(inputs, phase, params.draftPath, isSubagent));
      // Gate the main agent's first fan-out on its own draft existing; then background every spawn.
      if (SPAWN_TOOLS.has(toolName)) {
        if (!isSubagent && !params.mainDraftWritten)
          return denyPreTool(spawnFloorMessage(params.draftPath));
        return forceBackgroundSpawn(rec["tool_input"]);
      }
      return {};
    }
    default:
      return {};
  }
};

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

export const parseEpochSecMs = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
};

// Prefer the shared deadline anchor: a fresh subagent's transcript-start reads ≈0, so per-transcript
// elapsed would leave the fan-out unsteered. Falls back to transcript start, then null (axis off).
export const anchoredElapsedMs = (src: {
  readonly deadlineMs: number | null;
  readonly wallMs: number | null;
  readonly firstTsMs: number | null;
  readonly nowMs: number;
}): number | null => {
  if (src.deadlineMs !== null && src.wallMs !== null)
    return Math.max(0, src.wallMs - (src.deadlineMs - src.nowMs));
  if (src.firstTsMs !== null) return Math.max(0, src.nowMs - src.firstTsMs);
  return null;
};

// Round the wall UP to whole seconds so the anchor never expires before the matching timeout kill.
export const deadlineEpochSec = (wallMs: number, nowMs: number): number =>
  Math.floor(nowMs / 1000) + Math.ceil(wallMs / 1000);

// 0 is valid: it disables the fraction term, leaving only the flat floor.
export const parseFraction = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
};

// One string wired to both hooks; it self-dispatches on the event it reads from stdin.
export const budgetHookCommand = (
  draftPath: string,
  opts: {
    readonly budgetUsd?: string;
    readonly wall?: string;
    readonly prices?: string;
    readonly reserveFrac?: string;
    readonly reserveGrowth?: string;
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
    ...(opts.reserveGrowth ? ["--reserve-growth", shellQuote(opts.reserveGrowth)] : []),
    ...(opts.reserveUsd ? ["--reserve-usd", shellQuote(opts.reserveUsd)] : []),
    ...(opts.reserveWall ? ["--reserve-wall", shellQuote(opts.reserveWall)] : []),
  ].join(" ");
