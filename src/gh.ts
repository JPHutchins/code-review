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

export const runGhApi: GhApi = (args, stdin, env) =>
  execFileWithTimeout({
    command: "gh",
    args: ["api", ...args],
    label: `gh api ${describeEndpoint(args)}`,
    timeoutMs: subprocessTimeoutMs(),
    env,
    stdin,
  });
