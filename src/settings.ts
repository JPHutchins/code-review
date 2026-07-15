// The review agent's whole hook discipline as one --settings file (data, not shell): the Stop
// deliverable gate + the two budget hooks (one self-dispatching command wired to both tool events).

import { defaultHookCommand } from "./stop-gate.js";
import { budgetHookCommand } from "./budget.js";

interface CommandHook {
  readonly type: "command";
  readonly command: string;
}
interface HookEntry {
  readonly hooks: readonly CommandHook[];
}

// PreToolUse/PostToolBatch carry no matcher — they run for every tool; the CLI decides per tool_name.
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

// The budget command self-dispatches on the stdin event, so it is built once and wired to both.
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
