import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { readRepoFile, allWorkflows } from "./test-util.js";

const ACCESS_RANK = new Map<string, number>([
  ["none", 0],
  ["read", 1],
  ["write", 2],
]);

const rankOf = (access: string | undefined): number => ACCESS_RANK.get(access ?? "none") ?? 0;

type PermissionSet = ReadonlyMap<string, string>;

const EMPTY: PermissionSet = new Map();

// Every scope GitHub grants, so the `read-all` / `write-all` shorthands can be expanded to the set
// they actually stand for instead of being read as no permissions at all.
const ALL_SCOPES = [
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
] as const;

const asPermissionSet = (declared: unknown): PermissionSet => {
  if (declared === "read-all") return new Map(ALL_SCOPES.map((scope) => [scope, "read"]));
  if (declared === "write-all") return new Map(ALL_SCOPES.map((scope) => [scope, "write"]));
  if (declared === null || typeof declared !== "object") return EMPTY;
  return new Map(
    Object.entries(declared).flatMap(([scope, access]) =>
      typeof access === "string" ? [[scope, access] as const] : [],
    ),
  );
};

const union = (sets: readonly PermissionSet[]): PermissionSet =>
  new Map(
    sets
      .flatMap((set) => [...set])
      .reduce<readonly (readonly [string, string])[]>(
        (merged, [scope, access]) =>
          merged.some(([seen]) => seen === scope)
            ? merged.map(([seen, held]) =>
                seen === scope && rankOf(access) > rankOf(held) ? [scope, access] : [seen, held],
              )
            : [...merged, [scope, access]],
        [],
      ),
  );

type Job = { readonly permissions?: unknown; readonly uses?: unknown };

type Workflow = { readonly on?: unknown; readonly permissions?: unknown; readonly jobs?: unknown };

const workflowOf = (path: string): Workflow => {
  const parsed: unknown = parseYaml(readRepoFile(path));
  return parsed !== null && typeof parsed === "object" ? parsed : {};
};

const jobsOf = (workflow: Workflow): readonly Job[] =>
  workflow.jobs !== null && typeof workflow.jobs === "object"
    ? Object.values(workflow.jobs).flatMap((job: unknown) =>
        job !== null && typeof job === "object" ? [job as Job] : [],
      )
    : [];

// A `uses:` edge to one of this project's reusables, by local path or by published ref. Reading it
// from the parsed job means documentation prose that mentions a `uses:` line cannot invent an edge.
const calledReusable = (job: Job): string | null => {
  const match =
    typeof job.uses === "string"
      ? /^(?:\.\/|[\w-]+\/code-review\/)(\.github\/workflows\/[\w.-]+\.ya?ml)(?:@\S+)?$/.exec(
          job.uses,
        )
      : null;
  return match?.[1] ?? null;
};

// What a caller has to hold for the run to start: everything the called reusable's own jobs request,
// plus what the reusables it delegates to need in turn. A callee job with no `permissions:` of its
// own requests nothing extra — it inherits whatever the caller granted.
const requiredBy = (reusablePath: string, seen: readonly string[] = []): PermissionSet =>
  seen.includes(reusablePath)
    ? EMPTY
    : union(
        jobsOf(workflowOf(reusablePath)).flatMap((job) => {
          const callee = calledReusable(job);
          return [
            ...(job.permissions !== undefined ? [asPermissionSet(job.permissions)] : []),
            ...(callee !== null ? [requiredBy(callee, [...seen, reusablePath])] : []),
          ];
        }),
      );

// A calling job's own `permissions:` REPLACES the workflow-level grant rather than intersecting it,
// so the grant is the job's block when it has one and the workflow's block otherwise.
const grantedTo = (workflow: Workflow, job: Job): PermissionSet =>
  asPermissionSet(job.permissions !== undefined ? job.permissions : workflow.permissions);

const missingGrants = (granted: PermissionSet, required: PermissionSet): readonly string[] =>
  [...required]
    .filter(([scope, access]) => rankOf(granted.get(scope)) < rankOf(access))
    .map(([scope, access]) => `${scope}: ${access} (granted ${granted.get(scope) ?? "none"})`);

const isReusable = (workflow: Workflow): boolean =>
  workflow.on !== null &&
  typeof workflow.on === "object" &&
  Object.keys(workflow.on).includes("workflow_call");

type CallSite = { readonly path: string; readonly missing: readonly string[] };

const callSites = (): readonly CallSite[] =>
  allWorkflows().flatMap((path) => {
    const workflow = workflowOf(path);
    if (isReusable(workflow)) return [];
    return jobsOf(workflow).flatMap((job) => {
      const callee = calledReusable(job);
      return callee === null
        ? []
        : [{ path, missing: missingGrants(grantedTo(workflow, job), requiredBy(callee)) }];
    });
  });

// A caller cannot grant a called reusable a permission it does not itself hold: GitHub refuses to
// start the run, before any job-level `if:` is evaluated, with no log and no check anywhere. That is
// how the /code-review comment trigger sat dead for three weeks (#208) after #115 added `checks:
// write` to three reusable jobs and only two of the three callers were updated. The requirement is
// derived from the reusables themselves, off a real YAML parse rather than a line scan, so a fourth
// caller cannot repeat it and an unmodelled YAML form cannot quietly under-count the requirement.
describe("reusable-workflow callers grant what the reusable requests (#208)", () => {
  const sites = callSites();

  it("finds every call site into this project's reusables", () => {
    expect(sites.map((site) => site.path)).toEqual([
      ".github/workflows/review-on-comment.yaml",
      ".github/workflows/review-selftest.yaml",
      ".github/workflows/review.yaml",
      "examples/workflows/review-on-comment.yaml",
    ]);
  });

  for (const [index, site] of sites.entries()) {
    it(`${site.path} (call site ${String(index)}) grants every permission its reusables request`, () => {
      expect(site.missing).toEqual([]);
    });
  }
});
