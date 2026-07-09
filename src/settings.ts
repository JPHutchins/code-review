// One Claude Code --settings file composing every hook this CLI uses to make a headless review agent
// safe and budget-disciplined (issue #38): the Stop deliverable gate (stop-gate.ts) and the two
// budget hooks (budget.ts) — the latter wired from a SINGLE self-dispatching command on both
// PreToolUse and PostToolBatch. The review job generates this once and passes it as --settings, so
// the whole discipline (can't stop draftless, steered toward convergence, forced to converge, and
// truncation-safe on a hard kill) is expressed in data, not shell.

import { defaultHookCommand } from "./stop-gate.js";
import { budgetHookCommand } from "./budget.js";

interface CommandHook {
  readonly type: "command";
  readonly command: string;
}
interface HookEntry {
  readonly hooks: readonly CommandHook[];
}

/** The composed settings. `PreToolUse`/`PostToolBatch` carry no matcher — they run for every tool,
 *  and the CLI decides per `tool_name` (allowing the convergence path, denying the rest at hard). */
export interface ReviewHookSettings {
  readonly hooks: {
    readonly Stop: readonly HookEntry[];
    readonly PreToolUse: readonly HookEntry[];
    readonly PostToolBatch: readonly HookEntry[];
  };
}

export interface ComposeSettingsOptions {
  readonly draftPath: string;
  readonly stop: {
    readonly kind?: string;
    readonly schema?: string;
    readonly schemaVersion?: string;
    readonly maxNudges?: string;
    readonly counter?: string;
  };
  readonly budget: {
    readonly budgetUsd?: string;
    readonly wall?: string;
    readonly prices?: string;
    readonly reserveFrac?: string;
    readonly reserveGrowth?: string;
    readonly reserveUsd?: string;
    readonly reserveWall?: string;
  };
}

/** Compose the Stop + PreToolUse + PostToolBatch settings for one review. The budget command is
 *  identical across the two tool events — it self-dispatches on the `hook_event_name` it reads from
 *  stdin — so it is built once and wired twice. */
export const composeReviewSettings = (opts: ComposeSettingsOptions): ReviewHookSettings => {
  const budgetCommand = budgetHookCommand(opts.draftPath, opts.budget);
  return {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: defaultHookCommand(opts.draftPath, opts.stop) }] },
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: budgetCommand }] }],
      PostToolBatch: [{ hooks: [{ type: "command", command: budgetCommand }] }],
    },
  };
};
