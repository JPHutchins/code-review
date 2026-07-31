// The single child-process boundary for the external CLIs (`gh`, `git`); pure callers inject fakes.

import { execFile } from "node:child_process";
import { errMsg } from "./util.js";

const MAX_BUFFER = 100 * 1024 * 1024;

// Node's child_process `timeout` is a `setTimeout` under the hood, which clamps any delay above the
// signed-32-bit maximum to 1ms — an over-large override would paradoxically kill every call almost
// instantly. Honor a large-but-valid ceiling; treat an out-of-range value as invalid (fall back).
const MAX_TIMEOUT_MS = 2_147_483_647;

// `/^\d+$/` matches the codebase's other numeric-env parsers (requireMaxNudges, requirePositiveInt):
// it rejects the surprising forms `Number` would coerce (`"0.5"` → 0.5ms, `"0x10"`, `"3e5"`).
export const parseTimeoutMs = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return parsed > 0 && parsed <= MAX_TIMEOUT_MS ? parsed : fallback;
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
  const stderrStr = stderr.trim();
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return `output exceeded ${String(MAX_BUFFER)} bytes (killed)`;
  // `killed` is set for any signal (the timeout SIGKILL, or an external one), so keep the child's own
  // stderr when it left some — an externally-killed child is still diagnosable from its output.
  if (e.killed === true)
    return `no response within ${String(timeoutMs)}ms (killed a hung child)${stderrStr ? `: ${stderrStr}` : ""}`;
  return stderrStr || errMsg(err);
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
    if (spec.stdin !== undefined) {
      // A SIGKILLed child (timeout/maxBuffer) can tear down its stdin mid-write; without this handler
      // the resulting EPIPE would crash the process instead of letting the promise reject.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(spec.stdin);
    }
  });
