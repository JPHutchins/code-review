import { readFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { runCommand } from "citty";
import { main } from "./index.js";

export const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

/** Thrown by the mocked process.exit below, distinguishing a deliberate exit from a real error. */
export class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${String(code)})`);
  }
}

/** Capture stdout/stderr writes and process.exit calls around a CLI invocation. */
export const runCli = async (
  rawArgs: readonly string[],
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}> => {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);

  let exitCode: number | null = null;
  try {
    await runCommand(main, { rawArgs: [...rawArgs] });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    exitCode = err.code;
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout, stderr, exitCode };
};

export const readRepoFile = (relativePath: string): string =>
  readFileSync(resolvePath(repoRoot, relativePath), "utf-8");

// One extension policy for every guard that inventories workflows, so a rename or a new extension
// cannot be picked up by one guard and silently missed by another.
export const WORKFLOW_EXTENSIONS = [".yaml", ".yml"] as const;

export const repoFiles = (
  directory: string,
  extensions: readonly string[] = WORKFLOW_EXTENSIONS,
): readonly string[] =>
  readdirSync(resolvePath(repoRoot, directory))
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .map((name) => `${directory}/${name}`)
    .sort();

export const WORKFLOW_DIRECTORIES = [".github/workflows", "examples/workflows"] as const;

export const allWorkflows = (): readonly string[] =>
  WORKFLOW_DIRECTORIES.flatMap((directory) => repoFiles(directory));

// A pre-#217 sticky's embedded marker. Nothing in production writes one any more — the write path
// emits only the artifact link — so tests that need a legacy sticky build it here. These are the
// fixtures for the decoder's legacy branch, which is what keeps every PR whose sticky predates #217
// able to seed its next round.
export const legacyEmbeddedMarker = (document: unknown): string =>
  `<!-- code-review:findings-json;base64 ${Buffer.from(JSON.stringify(document), "utf-8").toString("base64")} -->`;
