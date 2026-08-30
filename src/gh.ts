// The single GitHub-API shell boundary; pure callers inject a fake GhApi.

import { execFileWithTimeout, subprocessTimeoutMs } from "./exec.js";
import { errMsg } from "./util.js";

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
// endpoints now embed ANSI color in responses built from untrusted PR content (job logs, and any
// diff/conversation an author happens to carry raw escapes in). Every response here is CAPTURED —
// written to a file or parsed, never echoed to a terminal — so the escapes are always safe to allow.
// The refusal names its own remedy, so each call retries against the error it actually got: plain
// first (an old gh accepts it, a new gh accepts it for escape-free content), and a refusal retries
// with --allow-escape-sequences. A successful retry memoizes flag-first for the process — an old gh
// never sees the flag, so no capability probe is needed and no probe failure can silently degrade
// the boundary. The retry re-executes the command, so only IDEMPOTENT calls may retry — a write
// that already landed server-side before the refusal must surface loudly, never replay. The retry's
// cost is bounded by design: it re-fetches ONE already-buffered response (for a --paginate call,
// gh has buffered every page before it refuses, so the retry re-downloads the whole sequence once),
// and concurrent first calls can each refuse-and-retry once before the memoization lands — a
// one-time per-process per-endpoint doubling, paid again in each fresh workflow step.
let flagFirst: boolean | undefined;

export const withEscapeRetry = async <T>(
  run: (withFlag: boolean) => Promise<T>,
  idempotent: boolean,
): Promise<T> => {
  if (flagFirst) return run(true);
  try {
    return await run(false);
  } catch (err) {
    if (errMsg(err).includes("--allow-escape-sequences")) {
      if (!idempotent) throw err;
      flagFirst = true;
      return run(true);
    }
    throw err;
  }
};

// A write call is one carrying --input, an explicit --method, or a graphql invocation — a
// conservative reading: a `--method GET` is idempotent too, but nothing here issues one, and the one
// graphql read query loses nothing by opting out (JSON responses bypass gh's guard anyway), while
// the graphql minimize MUTATION carries neither REST write flag and must never replay.
const isIdempotentCall = (args: readonly string[]): boolean =>
  !args.includes("--input") && !args.includes("--method") && !args.includes("graphql");

export const runGhApi: GhApi = (args, stdin, env) =>
  withEscapeRetry(
    (withFlag) =>
      execFileWithTimeout({
        command: "gh",
        args: ["api", ...(withFlag ? ["--allow-escape-sequences"] : []), ...args],
        label: `gh api ${describeEndpoint(args)}`,
        timeoutMs: subprocessTimeoutMs(),
        env,
        stdin,
      }),
    isIdempotentCall(args),
  );
