// Stop-hook deliverable gate. A Claude Code `Stop` hook that refuses to let the review agent end
// its turn until it has written a findings document that validates against the schema — turning
// the "write your draft and validate before stopping" instruction from a hope into an invariant.
// The check is the same validation `code-review validate` performs.

import { readFileSync, writeFileSync } from "node:fs";
import { validateAgainstSchema } from "./validate.js";

/** Validation state of the agent's draft deliverable at the moment it tries to stop. */
export interface DraftState {
  readonly present: boolean;
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/** A Stop-hook outcome: `block` feeds `reason` back to the agent so it keeps working; `allow`
 *  lets the turn end. */
export type GateDecision =
  { readonly kind: "allow" } | { readonly kind: "block"; readonly reason: string };

/** The settings shape Claude Code reads from a `--settings` file to wire a Stop hook command. */
export interface StopHookSettings {
  readonly hooks: {
    readonly Stop: readonly {
      readonly hooks: readonly { readonly type: "command"; readonly command: string }[];
    }[];
  };
}

/** Allow when the draft validates or the nudge budget is spent; otherwise block with a reason
 *  that names what is wrong and reprompts the agent about the ONLY deliverable — a document
 *  validating against `kind`'s schema — so it can fix it. */
export const decideGate = (
  state: DraftState,
  nudges: number,
  maxNudges: number,
  draftPath: string,
  kind: string,
): GateDecision => {
  if (state.valid) return { kind: "allow" };
  if (nudges >= maxNudges) return { kind: "allow" };
  const whatsWrong = !state.present
    ? `${draftPath} does not exist yet`
    : `${draftPath} does not validate against the ${kind} schema:\n${state.errors
        .map((e) => `  - ${e}`)
        .join("\n")}`;
  return {
    kind: "block",
    reason: [
      `This review is not complete — ${whatsWrong}`,
      `The only deliverable is a ${kind} document that validates against the ${kind} schema — run "code-review print-schema ${kind}" to see the exact shape.`,
      `Write it to ${draftPath}, then run "code-review validate ${draftPath} --kind ${kind}" until it exits 0 before ending your turn.`,
    ].join("\n"),
  };
};

/** Read and validate the draft, resolving the schema from the parsed document when needed. Never
 *  throws — every failure mode (missing file, unreadable file, invalid JSON, an unresolvable or
 *  crashing schema lookup, a validator crash) degrades to a `DraftState` the gate can act on,
 *  rather than crashing the hook and letting the agent stop by default. */
export const draftState = (
  draftPath: string,
  resolveSchema: (parsed: unknown) => string,
): DraftState => {
  let raw: string;
  try {
    raw = readFileSync(draftPath, "utf-8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, valid: false, errors: [] };
    }
    return {
      present: true,
      valid: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      present: true,
      valid: false,
      errors: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  let schemaPath: string;
  try {
    schemaPath = resolveSchema(parsed);
  } catch (err) {
    return {
      present: true,
      valid: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
  try {
    return { present: true, ...validateAgainstSchema(parsed, schemaPath) };
  } catch (err) {
    return {
      present: true,
      valid: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
};

/** Nudge count persisted beside the draft across hook invocations within one review. Absent or
 *  unparseable counts read as 0, so a fresh review starts with a full budget. */
export const readNudges = (counterPath: string): number => {
  try {
    const n = Number.parseInt(readFileSync(counterPath, "utf-8").trim(), 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
};

/** Read-increment-write the nudge counter. */
export const bumpNudges = (counterPath: string): void => {
  writeFileSync(counterPath, `${String(readNudges(counterPath) + 1)}\n`);
};

/** POSIX single-quote a string for safe embedding in a hook command line. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The default hook command: this CLI re-invoked as the gate, carrying the same schema/budget
 *  flags so the hook validates exactly as the caller intended. */
export const defaultHookCommand = (
  draftPath: string,
  opts: {
    readonly kind?: string;
    readonly schema?: string;
    readonly schemaVersion?: string;
    readonly maxNudges?: string;
    readonly counter?: string;
  },
): string =>
  [
    "code-review stop-gate --draft",
    shellQuote(draftPath),
    ...(opts.kind ? ["--kind", shellQuote(opts.kind)] : []),
    ...(opts.schema ? ["--schema", shellQuote(opts.schema)] : []),
    ...(opts.schemaVersion ? ["--schema-version", shellQuote(opts.schemaVersion)] : []),
    ...(opts.maxNudges ? ["--max-nudges", shellQuote(opts.maxNudges)] : []),
    ...(opts.counter ? ["--counter", shellQuote(opts.counter)] : []),
  ].join(" ");

/** The settings object that wires `command` as a Stop hook. */
export const stopHookSettings = (command: string): StopHookSettings => ({
  hooks: { Stop: [{ hooks: [{ type: "command", command }] }] },
});
