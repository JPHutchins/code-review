// The review agent's whole hook discipline as one --settings file (data, not shell): the Stop
// deliverable gate + the two budget hooks (one self-dispatching command wired to both tool events),
// and, when given one, the context every subagent starts with.

import { defaultHookCommand, shellQuote } from "./stop-gate.js";
import { budgetHookCommand } from "./budget.js";

interface CommandHook {
  readonly type: "command";
  readonly command: string;
}
interface HookEntry {
  readonly hooks: readonly CommandHook[];
}

// PreToolUse/PostToolBatch carry no matcher — they run for every tool; the CLI decides per tool_name.
// SubagentStart carries none either, so every fan-out subagent type receives the context.
export interface ReviewHookSettings {
  readonly hooks: {
    readonly Stop: readonly HookEntry[];
    readonly PreToolUse: readonly HookEntry[];
    readonly PostToolBatch: readonly HookEntry[];
    readonly SubagentStart?: readonly HookEntry[];
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
  // Trusted text every subagent starts with: --append-system-prompt reaches only the main agent.
  readonly subagentContext?: string;
}

// The budget command self-dispatches on the stdin event, so it is built once and wired to both.
export const composeReviewSettings = (opts: ComposeSettingsOptions): ReviewHookSettings => {
  const budgetCommand = budgetHookCommand(opts.draftPath, opts.budget);
  return {
    hooks: {
      Stop: commandHooks(defaultHookCommand(opts.draftPath, opts.stop)),
      PreToolUse: commandHooks(budgetCommand),
      PostToolBatch: commandHooks(budgetCommand),
      ...(opts.subagentContext !== undefined && opts.subagentContext.trim().length > 0
        ? { SubagentStart: commandHooks(subagentContextHookCommand(opts.subagentContext)) }
        : {}),
    },
  };
};

const commandHooks = (command: string): readonly HookEntry[] => [
  { hooks: [{ type: "command", command }] },
];

// The JSON additionalContext form, the only one that reaches the subagent's context.
export const subagentContextHookCommand = (context: string): string =>
  `printf '%s\\n' ${shellQuote(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: context },
    }),
  )}`;
