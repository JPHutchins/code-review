// The single child-process boundary for the external CLIs (`gh`, `git`); pure callers inject fakes.

import { execFile } from "node:child_process";

const MAX_BUFFER = 100 * 1024 * 1024;

// Node's child_process `timeout` is a `setTimeout` under the hood, which clamps any delay above the
// signed-32-bit maximum to 1ms — an over-large override would paradoxically kill every call almost
// instantly. Honor a large-but-valid ceiling; treat an out-of-range value as invalid (fall back).
const MAX_TIMEOUT_MS = 2_147_483_647;

export const parseTimeoutMs = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_TIMEOUT_MS ? parsed : fallback;
};

const SUBPROCESS_TIMEOUT_ENV = "CODE_REVIEW_SUBPROCESS_TIMEOUT_MS";
const DEFAULT_SUBPROCESS_TIMEOUT_MS = 120_000;

export const subprocessTimeoutMs = (): number =>
  parseTimeoutMs(process.env[SUBPROCESS_TIMEOUT_ENV], DEFAULT_SUBPROCESS_TIMEOUT_MS);

// A child that outlives the timeout is killed via SIGKILL, and `maxBuffer` overflow kills it too;
// both surface as `killed`, so name which one fired (and fall back to the child's own stderr/error)
// rather than blame a timeout for an overflow.
export const classifyExecError = (err: unknown, stderr: string, timeoutMs: number): string => {
  const e = err as { killed?: boolean; code?: unknown };
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return `output exceeded ${String(MAX_BUFFER)} bytes (killed)`;
  if (e.killed === true) return `no response within ${String(timeoutMs)}ms (killed a hung child)`;
  const stderrStr = stderr.trim();
  return stderrStr || (err instanceof Error ? err.message : "unknown error");
};

export type ExecSpec = {
  readonly command: string;
  readonly args: readonly string[];
  readonly label: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
};

// A wedged external CLI (a stalled network read, an interactive auth/pager prompt that never
// returns) would otherwise hang the whole job until the workflow's own wall clock fires. `env` is
// spread over the inherited environment only when overrides are supplied; untrusted values reach the
// child via `env.NAME`, never interpolated into a command.
export const execFileWithTimeout = (spec: ExecSpec): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      spec.command,
      [...spec.args],
      {
        ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
        encoding: "utf-8",
        maxBuffer: MAX_BUFFER,
        timeout: spec.timeoutMs,
        killSignal: "SIGKILL",
      },
      (err, stdout, stderr) => {
        if (err)
          reject(
            new Error(`${spec.label} failed: ${classifyExecError(err, stderr, spec.timeoutMs)}`),
          );
        else resolve(stdout);
      },
    );
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
  });
