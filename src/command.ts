// Parses a ChatOps trigger comment ("/code-review [24m] [$1.00] <instructions>") into structured
// review overrides, and resolves the PR head from the comment's PR NUMBER via the API (never from a
// SHA in the comment). The untrusted comment is parsed here, in type-safe code, not in workflow bash.

import * as t from "io-ts";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";

export interface CommandArgs {
  // null ⇒ the commenter did not specify it; the reusable workflow keeps its configured default.
  readonly durationSec: number | null;
  readonly usd: number | null;
  readonly instructions: string;
  // Human-readable adjustments (a clamp hit, a truncation) for the CI log — the sticky footer shows
  // the values actually used, so these are diagnostics, not the user-facing signal.
  readonly notes: readonly string[];
}

export type CommandParse =
  { readonly kind: "not-a-command" } | { readonly kind: "command"; readonly args: CommandArgs };

export interface ParseOptions {
  readonly trigger: string;
  // null ⇒ no clamp (a comment could then request an unbounded wall/budget — callers set a ceiling).
  readonly maxDurationSec: number | null;
  readonly maxUsd: number | null;
  readonly maxInstructionsLen: number;
}

const DURATION_RE = /^(\d+)(h|m|s)$/;
const USD_RE = /^\$(\d+(?:\.\d+)?)$/;

const toSeconds = (n: number, unit: string): number =>
  unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;

// null when the body does not begin with the trigger as a WHOLE token (so "/code-reviewer" is not a
// hit); otherwise the remainder after the trigger, leading whitespace and all.
const stripTrigger = (body: string, trigger: string): string | null => {
  const trimmed = body.replace(/^\s+/, "");
  if (!trimmed.startsWith(trigger)) return null;
  const after = trimmed.slice(trigger.length);
  return after === "" || /^\s/.test(after) ? after : null;
};

// Consume leading whitespace-delimited tokens that are a duration or a dollar amount (each at most
// once, either order); stop at the first token that is neither (or a duplicate). The untouched
// remainder — from that token on, its own leading whitespace included — is the instructions.
const scanLeading = (
  s: string,
  acc: { readonly durationSec: number | null; readonly usd: number | null },
): { readonly durationSec: number | null; readonly usd: number | null; readonly rest: string } => {
  const m = /^(\s*)(\S+)([\s\S]*)$/.exec(s);
  if (m === null) return { ...acc, rest: "" };
  const [, , token = "", tail = ""] = m;
  const dm = DURATION_RE.exec(token);
  if (dm && acc.durationSec === null)
    return scanLeading(tail, {
      ...acc,
      durationSec: toSeconds(Number.parseInt(dm[1] ?? "", 10), dm[2] ?? "s"),
    });
  const um = USD_RE.exec(token);
  if (um && acc.usd === null)
    return scanLeading(tail, { ...acc, usd: Number.parseFloat(um[1] ?? "") });
  return { ...acc, rest: s };
};

const clampDuration = (
  requested: number | null,
  ceiling: number | null,
): { readonly value: number | null; readonly notes: readonly string[] } =>
  requested !== null && ceiling !== null && requested > ceiling
    ? {
        value: ceiling,
        notes: [
          `requested duration ${String(requested)}s exceeds the ${String(ceiling)}s ceiling — clamped to ${String(ceiling)}s`,
        ],
      }
    : { value: requested, notes: [] };

const clampUsd = (
  requested: number | null,
  ceiling: number | null,
): { readonly value: number | null; readonly notes: readonly string[] } =>
  requested !== null && ceiling !== null && requested > ceiling
    ? {
        value: ceiling,
        notes: [
          `requested $${requested.toFixed(2)} exceeds the $${ceiling.toFixed(2)} ceiling — clamped to $${ceiling.toFixed(2)}`,
        ],
      }
    : { value: requested, notes: [] };

const capInstructions = (
  text: string,
  maxLen: number,
): { readonly value: string; readonly notes: readonly string[] } =>
  text.length > maxLen
    ? {
        value: text.slice(0, maxLen),
        notes: [
          `instructions truncated from ${String(text.length)} to ${String(maxLen)} characters`,
        ],
      }
    : { value: text, notes: [] };

export const parseCommandArgs = (body: string, options: ParseOptions): CommandParse => {
  const afterTrigger = stripTrigger(body, options.trigger);
  if (afterTrigger === null) return { kind: "not-a-command" };
  const scan = scanLeading(afterTrigger, { durationSec: null, usd: null });
  const duration = clampDuration(scan.durationSec, options.maxDurationSec);
  const usd = clampUsd(scan.usd, options.maxUsd);
  const instructions = capInstructions(scan.rest.trim(), options.maxInstructionsLen);
  return {
    kind: "command",
    args: {
      durationSec: duration.value,
      usd: usd.value,
      instructions: instructions.value,
      notes: [...duration.notes, ...usd.notes, ...instructions.notes],
    },
  };
};

const PrHeadCodec = t.type({
  head_sha: t.string,
  head_ref: t.string,
  head_repo: t.union([t.string, t.null]),
  state: t.string,
});

export const resolvePrHead = async (
  repo: string,
  prNumber: number,
  ghApi: GhApi,
): Promise<t.TypeOf<typeof PrHeadCodec>> => {
  const stdout = await ghApi([
    `repos/${repo}/pulls/${String(prNumber)}`,
    "--jq",
    "{head_sha: .head.sha, head_ref: .head.ref, head_repo: .head.repo.full_name, state: .state}",
  ]);
  const decoded = PrHeadCodec.decode(JSON.parse(stdout) as unknown);
  if (decoded._tag === "Left") {
    throw new Error(`PR head for #${String(prNumber)} did not match the expected shape`);
  }
  return decoded.right;
};

export interface CommandInput {
  readonly repo: string;
  readonly prNumber: number;
  readonly body: string;
  readonly options: ParseOptions;
}

export type CommandResult =
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "run";
      readonly headSha: string;
      readonly headBranch: string;
      readonly headRepo: string;
      readonly args: CommandArgs;
    };

export const parseCommand = async (
  input: CommandInput,
  ghApi: GhApi = runGhApi,
): Promise<CommandResult> => {
  const parse = parseCommandArgs(input.body, input.options);
  if (parse.kind === "not-a-command") {
    return {
      kind: "skip",
      reason: `comment does not begin with the trigger "${input.options.trigger}"`,
    };
  }
  const head = await resolvePrHead(input.repo, input.prNumber, ghApi).catch((err: unknown) =>
    err instanceof Error ? err : new Error(String(err)),
  );
  if (head instanceof Error) {
    return {
      kind: "skip",
      reason: `could not resolve PR #${String(input.prNumber)}: ${head.message}`,
    };
  }
  if (head.state !== "open") {
    return {
      kind: "skip",
      reason: `PR #${String(input.prNumber)} is not open (state: ${head.state})`,
    };
  }
  return {
    kind: "run",
    headSha: head.head_sha,
    headBranch: head.head_ref,
    headRepo: head.head_repo ?? input.repo,
    args: parse.args,
  };
};

// A heredoc delimiter guaranteed not to equal any line of the (untrusted) instructions, so the value
// can't break out of its $GITHUB_OUTPUT block and forge later outputs (e.g. should_run=true). A
// 128-bit random tag never collides in practice; the bounded recursion is belt-and-braces.
export const safeHeredocDelim = (
  instructions: string,
  randomHex: () => string,
  attemptsLeft = 8,
): string => {
  const candidate = `GHOUT_${randomHex()}`;
  if (!instructions.split("\n").includes(candidate)) return candidate;
  if (attemptsLeft <= 0) throw new Error("could not derive a collision-free heredoc delimiter");
  return safeHeredocDelim(instructions, randomHex, attemptsLeft - 1);
};

export const renderCommandOutputs = (result: CommandResult, delim: string): string => {
  if (result.kind === "skip") return "should_run=false\n";
  const { headSha, headBranch, headRepo, args } = result;
  return `${[
    "should_run=true",
    `head_sha=${headSha}`,
    `head_branch=${headBranch}`,
    `head_repo=${headRepo}`,
    `duration=${args.durationSec === null ? "" : `${String(args.durationSec)}s`}`,
    `usd=${args.usd === null ? "" : args.usd.toFixed(2)}`,
    `instructions<<${delim}`,
    args.instructions,
    delim,
  ].join("\n")}\n`;
};
