// The single GitHub-API shell boundary; pure callers inject a fake GhApi.

import { execFile } from "node:child_process";

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

// Untrusted values (bot login, marker) reach jq via `env.NAME`, never interpolated into the filter.
export const runGhApi: GhApi = (args, stdin, env) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      "gh",
      ["api", ...args],
      { env: { ...process.env, ...env }, encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const stderrStr = typeof stderr === "string" && stderr.trim() ? stderr.trim() : "";
          const errStr = err instanceof Error ? err.message : "unknown error";
          reject(new Error(`gh api ${describeEndpoint(args)} failed: ${stderrStr || errStr}`));
        } else {
          resolve(stdout);
        }
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
