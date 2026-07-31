// The single GitHub-API shell boundary; pure callers inject a fake GhApi.

import { execFile } from "node:child_process";

export type GhApi = (
  args: readonly string[],
  stdin?: string,
  env?: Readonly<Record<string, string>>,
) => Promise<string>;

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
          // Name the endpoint (args[0] is always the API path) so a swallowed 403 says WHICH call
          // failed, not just that one did — the difference between diagnosable and a mystery.
          const endpoint = args[0] ?? "(no endpoint)";
          reject(new Error(`gh api ${endpoint} failed: ${stderrStr || errStr}`));
        } else {
          resolve(stdout);
        }
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
