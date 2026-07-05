// The `gh api` effect: the single shell boundary for GitHub API calls. Pure callers inject a
// fake; the default implementation shells out to the `gh` CLI (auth via GH_TOKEN in the env).

import { execFile } from "node:child_process";

/** Signature of the `gh api` effect. Default implementation shells out to the `gh` CLI. */
export type GhApi = (
  args: readonly string[],
  stdin?: string,
  env?: Readonly<Record<string, string>>,
) => Promise<string>;

/** Default effect: execFile gh. Extra `env` merges over process.env for this call only —
 *  used to pass untrusted values (bot login, marker) to jq via `env.NAME`, never interpolated
 *  into the filter text (SPEC §5.4). */
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
          reject(new Error(`gh api failed: ${stderrStr || errStr}`));
        } else {
          resolve(stdout);
        }
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
