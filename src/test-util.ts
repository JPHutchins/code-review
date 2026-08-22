import { readFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

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
