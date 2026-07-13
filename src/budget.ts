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

import { basename } from "node:path";

import { shellQuote } from "./stop-gate.js";
import { asRecord } from "./util.js";

/** The environment variable carrying the run's absolute deadline as Unix epoch SECONDS. The review
 *  job exports it right before `claude -p` (from `code-review deadline`), and every hook subprocess —
 *  the main agent's AND each fan-out subagent's — inherits it, so all measure the SAME true remaining
 *  wall. Without it each hook derived elapsed from its own transcript's first timestamp, which reads
 *  ≈0 inside a freshly-spawned subagent, leaving the skill's parallel fan-out entirely unsteered until
 *  the wall (issue #45). */
export const DEADLINE_ENV = "CODE_REVIEW_DEADLINE_EPOCH";

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

/** The headroom to hold back for wind-down, judged per axis as max(flat floor, effective-frac × the
 *  budget): the flat floor keeps a tiny budget from converging with no absolute room left to write and
 *  validate the draft, while the fraction lets a large budget scale. The effective fraction GROWS with
 *  how far into the budget the run already is — `frac + growth × (used / limit)` — so convergence
 *  pressure escalates the longer the review has run, reserving proportionally more tail for the
 *  write→validate→fix loop rather than triggering at one late cliff (issue #45; a wall-killed review
 *  wrote its first draft at ~85% and ran out of time adapting it to the schema). The soft (steer) tier
 *  reserves SOFT_MULTIPLE× the hard (force) tier, so the agent is nudged with a whole extra reserve
 *  still in hand rather than only at the brink (issue #38). */
export interface ReserveParams {
  readonly frac: number;
  readonly growth: number;
  readonly flatUsd: number;
  readonly flatMs: number;
}

/** Defaults sized for real reviews: hold back a base 15% of the budget, growing by up to another 25%
 *  as the run approaches its limit (so hard convergence lands near ~68% of the wall rather than ~85%,
 *  soft near ~47%), but never less than $0.02 / 2 minutes of absolute wind-down room. `growth: 0`
 *  recovers the old flat-reserve behaviour. */
export const DEFAULT_RESERVE: ReserveParams = {
  frac: 0.15,
  growth: 0.25,
  flatUsd: 0.02,
  flatMs: 120_000,
};

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
 *  hard reserve is max(flat floor, effFrac × limit), where effFrac grows with how far into the budget
 *  the run is — `frac + growth × usedFrac` — so it converges earlier the longer it has run; the soft
 *  reserve is SOFT_MULTIPLE× the hard one. `usedFrac` is clamped to [0, 1] so an over-budget axis
 *  simply pins the growth term at its max rather than compounding past it. */
const axisSeverity = (a: Axis, reserve: ReserveParams): 0 | 1 | 2 => {
  const usedFrac = Math.min(1, Math.max(0, a.used / a.limit));
  const effFrac = reserve.frac + reserve.growth * usedFrac;
  const hardReserve = Math.max(a.flat, effFrac * a.limit);
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

const directive = (phase: Exclude<BudgetPhase, { kind: "ok" }>, draftPath: string): string =>
  phase.kind === "hard"
    ? `Budget nearly exhausted — STOP all new investigation now. Write your COMPLETE findings to ${draftPath} and run \`code-review validate ${draftPath} --explain\` until it passes (--explain prints the exact schema when the shape is wrong). Other tools are blocked until that draft is written.`
    : `Wind down investigation and write your COMPLETE findings to ${draftPath} now, then run \`code-review validate ${draftPath} --explain\` (it prints the exact schema if the shape is wrong) — you may run out of budget before you finish otherwise.`;

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

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Does this tool call WRITE to the findings draft? A file-writing tool targeting the path
 *  (Write/Edit/MultiEdit via `file_path`, NotebookEdit via `notebook_path`), or a Bash redirect,
 *  heredoc, or `tee` into it. Reads (`cat`, `code-review validate`) are deliberately NOT matched —
 *  only mutation races the single writer. Matches the absolute path, its basename, and the literal
 *  `$DRAFT`/`${DRAFT}` token, since a fan-out agent reaches the file by any of those. */
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
    // A redirect/heredoc into the target (`> path`, `>> path`, `cat > path <<EOF`), or any `tee`
    // command that names it (tee writes every file argument). Gated to Bash so a non-shell tool that
    // merely carries a `command` field can't trip the deny.
    if (typeof cmd === "string")
      return targets.some(
        (t) =>
          new RegExp(`>>?\\s*['"]?${escapeRegExp(t)}`).test(cmd) ||
          (/\btee\b/.test(cmd) && cmd.includes(t)),
      );
  }
  return false;
};

/** The deny reason shown to a fan-out subagent that tries to write the draft. Agent-facing text — keep
 *  it free of internal metadata (issue numbers, refs); it ships to every user's review. */
export const singleWriterMessage = (draftPath: string): string =>
  `Only the main agent may write ${draftPath}. When a subagent writes it too, the concurrent writers clobber each other and the review comes out empty. Do NOT write, edit, or redirect into ${draftPath} — instead, return the findings you discovered in your reply (the field names are in the schema); the main agent collects every subagent's reported findings and writes the draft itself.`;

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
      const toolName = rec["tool_name"];
      const agentId = rec["agent_id"];
      // Single-writer enforcement, independent of budget phase: a fan-out subagent (`agent_id`
      // present; the main agent's input has none) must never write $DRAFT — concurrent writers race
      // and clobber it, which has produced empty reviews. The main agent alone writes the draft, from
      // the findings its subagents report back in their replies.
      if (
        typeof agentId === "string" &&
        agentId.length > 0 &&
        typeof toolName === "string" &&
        writesToDraft(toolName, rec["tool_input"], params.draftPath)
      )
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: singleWriterMessage(params.draftPath),
          },
        };
      if (phase.kind !== "hard") return {};
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

/** Parse a Unix epoch-SECONDS anchor (as `date +%s` prints it, and as `deadline` emits) to epoch ms;
 *  null when unset or not a bare positive integer, so the caller falls back to the per-transcript
 *  start rather than trusting a garbage anchor. */
export const parseEpochSecMs = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
};

/** The elapsed wall-clock to judge the time axis on, from the most reliable source available. Prefers
 *  the ABSOLUTE anchor — a fixed run deadline (epoch ms) shared across every hook process — computed
 *  as `wall − (deadline − now)`; the per-transcript first timestamp (`firstTsMs`) is only the fallback
 *  because inside a freshly-spawned subagent it reads ≈0, so during the skill's parallel fan-out the
 *  budget hooks stay blind and never steer (issue #45). Falls back to the transcript start when no
 *  anchor is set (manual/local runs), then to null when neither is knowable (time axis disabled).
 *  Clamped to ≥ 0 — a passed deadline or clock skew reads as fully elapsed, never negative. */
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

/** The epoch-SECONDS deadline for a `wallMs` run starting now — what the review job exports as
 *  `DEADLINE_ENV`. The wall is rounded UP to whole seconds so the anchor never expires before the
 *  matching `timeout` kill. */
export const deadlineEpochSec = (wallMs: number, nowMs: number): number =>
  Math.floor(nowMs / 1000) + Math.ceil(wallMs / 1000);

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
