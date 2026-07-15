// A Claude Code Stop hook that refuses to let the review agent end its turn until it has written a
// findings document that validates against the schema — turning "validate before stopping" from a
// hope into an invariant. Same validation as `code-review validate`.

import { readFileSync, writeFileSync } from "node:fs";
import { validateAgainstSchema } from "./validate.js";
import { errMsg } from "./util.js";

// Distinguishes an UNREADABLE file (EACCES/EISDIR) from an INVALID one — "does not validate" is a
// lie when the file could not even be read.
export type DraftState =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly error: string }
  | { readonly kind: "invalid"; readonly errors: readonly string[] }
  | { readonly kind: "valid" };

export type GateDecision =
  { readonly kind: "allow" } | { readonly kind: "block"; readonly reason: string };

const whatsWrong = (
  state: Exclude<DraftState, { kind: "valid" }>,
  draftPath: string,
  kind: string,
): string => {
  switch (state.kind) {
    case "missing":
      return `${draftPath} does not exist yet`;
    case "unreadable":
      return `${draftPath} could not be read: ${state.error}`;
    case "invalid":
      return `${draftPath} does not validate against the ${kind} schema:\n${state.errors
        .map((e) => `  - ${e}`)
        .join("\n")}`;
  }
};

export interface StopHookSettings {
  readonly hooks: {
    readonly Stop: readonly {
      readonly hooks: readonly { readonly type: "command"; readonly command: string }[];
    }[];
  };
}

export const decideGate = (
  state: DraftState,
  nudges: number,
  maxNudges: number,
  draftPath: string,
  kind: string,
): GateDecision => {
  if (state.kind === "valid") return { kind: "allow" };
  if (nudges >= maxNudges) return { kind: "allow" };
  return {
    kind: "block",
    reason: [
      `This review is not complete — ${whatsWrong(state, draftPath, kind)}`,
      `The only deliverable is a ${kind} document that validates against the ${kind} schema — run "code-review print-schema ${kind}" to see the exact shape.`,
      `Write it to ${draftPath}, then run "code-review validate ${draftPath} --kind ${kind} --explain" until it exits 0 before ending your turn (--explain prints the schema when the shape is wrong).`,
    ].join("\n"),
  };
};

// Never throws — every failure mode degrades to a DraftState the gate can act on, rather than
// crashing the hook and letting the agent stop by default.
export const draftState = (
  draftPath: string,
  resolveSchema: (parsed: unknown) => string,
): DraftState => {
  let raw: string;
  try {
    raw = readFileSync(draftPath, "utf-8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable", error: errMsg(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "invalid",
      errors: [`not valid JSON: ${errMsg(err)}`],
    };
  }
  let schemaPath: string;
  try {
    schemaPath = resolveSchema(parsed);
  } catch (err) {
    return { kind: "invalid", errors: [errMsg(err)] };
  }
  try {
    const { valid, errors } = validateAgainstSchema(parsed, schemaPath);
    return valid ? { kind: "valid" } : { kind: "invalid", errors };
  } catch (err) {
    return { kind: "invalid", errors: [errMsg(err)] };
  }
};

// Absent or unparseable reads as 0, so a fresh review starts with a full nudge budget.
export const readNudges = (counterPath: string): number => {
  try {
    const n = Number.parseInt(readFileSync(counterPath, "utf-8").trim(), 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
};

// The caller passes the `current` it just read (no stale second read). May throw on a write failure —
// the caller decides how to handle that.
export const bumpNudges = (counterPath: string, current: number): void => {
  writeFileSync(counterPath, `${String(current + 1)}\n`);
};

export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

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

export const stopHookSettings = (command: string): StopHookSettings => ({
  hooks: { Stop: [{ hooks: [{ type: "command", command }] }] },
});
