// The single GitHub-API shell boundary; pure callers inject a fake GhApi.

import { execFileWithTimeout, subprocessTimeoutMs } from "./exec.js";

export type GhApi = (
  args: readonly string[],
  stdin?: string,
  env?: Readonly<Record<string, string>>,
) => Promise<string>;

// The endpoint for the error message: `graphql`, or the first path-shaped arg (a REST endpoint always
// contains a `/`), so a swallowed 403 names WHICH call failed even for `--method POST <path>` forms
// where the path is not args[0]. Falls back to args[0] for the pathological no-path case.
export const describeEndpoint = (args: readonly string[]): string =>
  args.find((a) => a === "graphql" || (a.includes("/") && !a.startsWith("-"))) ??
  args[0] ??
  "(no endpoint)";

// Newer gh REFUSES raw responses containing terminal escapes unless told to allow them, and GitHub's
// endpoints now embed ANSI color in responses that are built from untrusted PR content (job logs, and
// any diff/conversation an author happens to carry raw escapes in). Every response here is CAPTURED —
// written to a file or parsed, never echoed to a terminal — so the escapes are always safe to allow.
// Older ghs that predate the refusal also predate the flag, so support is probed ONCE per process via
// the unauthenticated zen endpoint. ONLY an explicit probe success enables the flag: any failure —
// the flag unknown on an old gh, or the probe unreachable — degrades to the plain call, because a
// false positive would break every call on an old gh.
let allowEscapes: boolean | undefined;

const ghAllowsEscapeFlag = async (): Promise<boolean> => {
  if (allowEscapes !== undefined) return allowEscapes;
  try {
    await execFileWithTimeout({
      command: "gh",
      args: ["api", "zen", "--allow-escape-sequences"],
      label: "gh api zen (escape-flag probe)",
      timeoutMs: subprocessTimeoutMs(),
    });
    allowEscapes = true;
  } catch {
    allowEscapes = false;
  }
  return allowEscapes;
};

export const runGhApi: GhApi = async (args, stdin, env) =>
  execFileWithTimeout({
    command: "gh",
    args: ["api", ...((await ghAllowsEscapeFlag()) ? ["--allow-escape-sequences"] : []), ...args],
    label: `gh api ${describeEndpoint(args)}`,
    timeoutMs: subprocessTimeoutMs(),
    env,
    stdin,
  });
