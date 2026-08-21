import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, "..");

type Access = "none" | "read" | "write";

const ACCESS_RANK: Readonly<Record<Access, number>> = { none: 0, read: 1, write: 2 };

type PermissionSet = Readonly<Record<string, Access>>;

type PermissionBlock = { readonly indent: number; readonly permissions: PermissionSet };

const readWorkflow = (relativePath: string): string =>
  readFileSync(resolvePath(repoRoot, relativePath), "utf-8");

const isAccess = (value: string): value is Access => value in ACCESS_RANK;

const permissionEntry = (line: string, openerIndent: number): readonly [string, Access] | null => {
  const match = /^(\s*)([a-z-]+):\s*([a-z]+)\s*(?:#.*)?$/.exec(line);
  if (match === null) return null;
  const [, indent = "", key = "", access = ""] = match;
  return indent.length > openerIndent && isAccess(access) ? [key, access] : null;
};

// A `permissions:` mapping is the run of `key: access` lines indented deeper than the `permissions:`
// key itself; the first line that is not one ends it. The opener's indent also says whose mapping it
// is — column 0 is the workflow's grant, deeper is one job's request.
const permissionBlocks = (yaml: string): readonly PermissionBlock[] => {
  const lines = yaml.split("\n");
  return lines.flatMap((line, index) => {
    const opener = /^(\s*)permissions:\s*(?:#.*)?$/.exec(line);
    if (opener === null) return [];
    const indent = (opener[1] ?? "").length;
    const following = lines.slice(index + 1).map((next) => permissionEntry(next, indent));
    const end = following.findIndex((entry) => entry === null);
    const entries = (end === -1 ? following : following.slice(0, end)).filter(
      (entry): entry is readonly [string, Access] => entry !== null,
    );
    return [{ indent, permissions: Object.fromEntries(entries) }];
  });
};

const union = (sets: readonly PermissionSet[]): PermissionSet =>
  sets.reduce<PermissionSet>(
    (merged, set) =>
      Object.entries(set).reduce<PermissionSet>(
        (acc, [key, access]) =>
          ACCESS_RANK[access] > ACCESS_RANK[acc[key] ?? "none"] ? { ...acc, [key]: access } : acc,
        merged,
      ),
    {},
  );

const blocksAt = (path: string, isWorkflowLevel: boolean): PermissionSet =>
  union(
    permissionBlocks(readWorkflow(path))
      .filter((block) => (block.indent === 0) === isWorkflowLevel)
      .map((block) => block.permissions),
  );

const granted = (path: string): PermissionSet => blocksAt(path, true);

const requested = (path: string): PermissionSet => blocksAt(path, false);

const workflowFiles = (directory: string): readonly string[] =>
  readdirSync(resolvePath(repoRoot, directory))
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map((name) => `${directory}/${name}`);

const allWorkflows = [
  ...workflowFiles(".github/workflows"),
  ...workflowFiles("examples/workflows"),
] as const;

// A `uses:` edge to one of this project's reusables, whether by local path or by published ref.
const calledReusables = (path: string): readonly string[] => [
  ...new Set(
    [
      ...readWorkflow(path).matchAll(
        /uses:\s*(?:\.\/|[\w-]+\/code-review\/)(\.github\/workflows\/[\w.-]+\.ya?ml)/g,
      ),
    ]
      .map((match) => match[1])
      .filter((called): called is string => called !== undefined && called !== path),
  ),
];

// Everything a caller must hold for the run to start: what the reusable's own jobs request, plus
// what the reusables it delegates to need in turn.
const transitivelyRequested = (path: string): PermissionSet =>
  union([requested(path), ...calledReusables(path).map(transitivelyRequested)]);

const missingGrants = (path: string): readonly string[] =>
  Object.entries(transitivelyRequested(path))
    .filter(([key, access]) => ACCESS_RANK[granted(path)[key] ?? "none"] < ACCESS_RANK[access])
    .map(([key, access]) => `${key}: ${access} (granted ${granted(path)[key] ?? "none"})`);

// A reusable holds nothing of its own — its caller grants for it — so the obligation stops at the
// workflows real events start.
const isReusable = (path: string): boolean => /^\s+workflow_call:/m.test(readWorkflow(path));

const callers = allWorkflows.filter(
  (path) => !isReusable(path) && calledReusables(path).length > 0,
);

// A caller cannot grant a called reusable a permission it does not itself hold: GitHub refuses to
// start the run, before any job-level `if:` is evaluated, with no log and no check anywhere. That is
// how the /code-review comment trigger sat dead for three weeks (#208) after #115 added `checks:
// write` to three reusable jobs and only two of the three callers were updated. Derive the
// requirement from the reusables themselves, so a fourth caller cannot repeat it.
describe("reusable-workflow callers grant what the reusable requests (#208)", () => {
  it("finds the callers and the permissions they have to hold", () => {
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers)
      expect(Object.keys(transitivelyRequested(caller)).length).toBeGreaterThan(0);
  });

  for (const caller of callers) {
    it(`${caller} grants every permission its reusables request`, () => {
      expect(missingGrants(caller)).toEqual([]);
    });
  }
});
