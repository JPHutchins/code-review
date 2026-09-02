import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { readRepoFile, allWorkflows } from "./test-util.js";

// A run script's own text, per step — parsed out of the workflow rather than grepped for, so a step
// whose shape this file does not model shows up as a missing script instead of passing silently.
const runScripts = (workflowPath: string): ReadonlyArray<{ step: string; script: string }> => {
  const doc = parseYaml(readRepoFile(workflowPath)) as unknown;
  if (doc === null || typeof doc !== "object") return [];
  const jobs = (doc as { jobs?: unknown }).jobs;
  if (jobs === null || typeof jobs !== "object") return [];
  return Object.entries(jobs as Record<string, unknown>).flatMap(([jobName, job]) => {
    const steps = (job as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) return [];
    return steps.flatMap((step: unknown, index: number) => {
      const run = (step as { run?: unknown }).run;
      if (typeof run !== "string") return [];
      const name = (step as { name?: unknown }).name;
      return [
        {
          step: `${workflowPath} → ${jobName} → ${typeof name === "string" ? name : `step ${String(index)}`}`,
          script: run,
        },
      ];
    });
  });
};

// A line that is only an argument — a quoted array expansion or a bare long option — cannot begin a
// command. Continuation is what makes it an argument of the line above.
const isArgumentOnlyLine = (line: string): boolean =>
  /^"\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}"$/.test(line) || /^--[a-z][a-z0-9-]*$/.test(line);

const orphanedArguments = (script: string): readonly string[] => {
  const lines = script.split("\n");
  return lines.flatMap((raw, index) => {
    const line = raw.trim();
    if (!isArgumentOnlyLine(line)) return [];
    const previous = lines
      .slice(0, index)
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .pop();
    return previous !== undefined && previous.endsWith("\\") ? [] : [line];
  });
};

describe("workflow run scripts — argument lines stay attached to their command", () => {
  // A merge that concatenated two conflict sides dropped the `\` after "${INLINE_ARGS[@]}", which
  // made "${UNVERIFIED_ARGS[@]}" its own command: the flag never reached `post`, and would have
  // failed the step under `set -e` the first time the array was non-empty. actionlint accepts it —
  // it is valid shell, just a different program — so the guard has to be here.
  it("every workflow's run scripts have no orphaned argument line", () => {
    const orphans = allWorkflows().flatMap((workflow) =>
      runScripts(workflow).flatMap(({ step, script }) =>
        orphanedArguments(script).map((line) => `${step}: ${line}`),
      ),
    );

    expect(orphans).toEqual([]);
  });

  it("reads a run script out of every workflow it checks", () => {
    const withScripts = allWorkflows().filter((workflow) => runScripts(workflow).length > 0);

    expect(withScripts.length).toBeGreaterThan(0);
    expect(withScripts).toContain(".github/workflows/review-reusable.yaml");
  });

  it("catches the orphan, and accepts the continued form", () => {
    const orphaned = [
      "code-review post findings.json \\",
      '  --repo "$REPO"',
      '  "${ARGS[@]}"',
    ].join("\n");
    const continued = [
      "code-review post findings.json \\",
      '  --repo "$REPO" \\',
      '  "${ARGS[@]}"',
    ].join("\n");

    expect(orphanedArguments(orphaned)).toEqual(['"${ARGS[@]}"']);
    expect(orphanedArguments(continued)).toEqual([]);
  });
});

describe("mechanic route prose — the reusable workflow and the example teach the SAME instructions", () => {
  // The mechanic PROMPT and its log-state notes steer the route's whole deliverable; the reusable
  // workflow and the consumer template carry byte-identical copies that must not drift (a template
  // consumer would otherwise get a different mechanic than a reusable consumer — e.g. one that still
  // reads logs without the reproduce-when-absent clause). Extracted from the parsed run scripts, not
  // grepped, so a missing copy shows up as a mismatch instead of passing silently.
  const steerLines = (workflowPath: string): readonly string[] =>
    runScripts(workflowPath)
      .flatMap(({ script }) => script.split("\n"))
      .map((line) => line.trim())
      .filter((line) => /^(PROMPT|LOG_SUBSET_NOTE|ROUTE_NOTE)="/.test(line))
      .sort();

  it("every mechanic steer line is byte-identical between review-reusable.yaml and the example", () => {
    const reusable = steerLines(".github/workflows/review-reusable.yaml");
    const example = steerLines("examples/workflows/review.yaml");
    expect(reusable.length).toBeGreaterThan(0);
    expect(example).toEqual(reusable);
  });
});
