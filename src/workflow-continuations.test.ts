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
      .filter((line) =>
        /^(PROMPT|LOG_SUBSET_NOTE|ROUTE_NOTE|JOBS_FILE_NOTE|SUBSET_JOBS_NOTE)="/.test(line),
      )
      .sort();

  it("every mechanic steer line is byte-identical between review-reusable.yaml and the example", () => {
    const reusable = steerLines(".github/workflows/review-reusable.yaml");
    const example = steerLines("examples/workflows/review.yaml");
    expect(reusable.length).toBeGreaterThan(0);
    expect(example).toEqual(reusable);
  });
});

describe("mechanic prompt assembly — the notes reach the prompt in the same order in both files", () => {
  it("the prompt splice delivers $ROUTE_NOTE then $LOG_SUBSET_NOTE in both workflows", () => {
    for (const workflowPath of [
      ".github/workflows/review-reusable.yaml",
      "examples/workflows/review.yaml",
    ]) {
      const splices = runScripts(workflowPath).filter(({ script }) =>
        script.includes("$ROUTE_NOTE$LOG_SUBSET_NOTE"),
      );
      expect(splices, `${workflowPath} splice`).not.toHaveLength(0);
    }
  });
});

describe("route budget parity — the example's literals mirror the reusable input defaults", () => {
  const inputDefaults = (workflowPath: string): Readonly<Record<string, string>> => {
    const doc = parseYaml(readRepoFile(workflowPath)) as {
      on?: { workflow_call?: { inputs?: Record<string, { default?: string | number }> } };
    };
    const inputs = doc.on?.workflow_call?.inputs ?? {};
    return Object.fromEntries(
      Object.entries(inputs).flatMap(([k, v]) =>
        v.default === undefined ? [] : [[k, String(v.default)]],
      ),
    );
  };

  const exampleRouteLiterals = (): {
    mechanic: string;
    mechanicGrace: string;
    full: string;
    fullGrace: string;
    usd: string;
  } => {
    const lines = runScripts("examples/workflows/review.yaml")
      .flatMap(({ script }) => script.split("\n"))
      .map((line) => line.trim());
    const routeLine = lines.find((l) => l.includes("AGENT_WALL=")) ?? "";
    const usdLine = lines.find((l) => l.startsWith("USD_LIMIT=")) ?? "";
    const mechanic = /AGENT_WALL=(\S+); GRACE=(\S+); else AGENT_WALL=(\S+); GRACE=([^;\s]+)/.exec(
      routeLine,
    );
    const usd = /USD_LIMIT=(\S+)/.exec(usdLine)?.[1];
    if (mechanic === null || usd === undefined) throw new Error("example route literals not found");
    return {
      mechanic: mechanic[1]!,
      mechanicGrace: mechanic[2]!,
      full: mechanic[3]!,
      fullGrace: mechanic[4]!,
      usd,
    };
  };

  // The empty-string coercion fallbacks a consumer actually receives when it wires an unset var —
  // `${{ inputs.X != '' && inputs.X || '<literal>' }}` — are budget sites of their own.
  const envCoercionFallbacks = (workflowPath: string): Readonly<Record<string, string>> => {
    const doc = parseYaml(readRepoFile(workflowPath)) as {
      jobs?: Record<
        string,
        { env?: Record<string, string>; steps?: ReadonlyArray<{ env?: Record<string, string> }> }
      >;
    };
    const fallbacks: Record<string, string> = {};
    for (const job of Object.values(doc.jobs ?? {})) {
      const envBlocks = [job.env ?? {}, ...(job.steps ?? []).map((step) => step.env ?? {})];
      for (const env of envBlocks) {
        for (const [k, v] of Object.entries(env)) {
          const m = /\|\|\s*['"]?([^'"]+)['"]?\s*\}\}\s*$/.exec(v);
          if (m !== null) fallbacks[k] = m[1]!;
        }
      }
    }
    return fallbacks;
  };

  const ENV_TO_INPUT: Readonly<Record<string, string>> = {
    FULL_TIME_LIMIT: "full_review_time_limit",
    FULL_GRACE: "full_review_grace_period",
    FULL_USD: "full_review_usd_limit",
    MECHANIC_TIME_LIMIT: "mechanic_time_limit",
    MECHANIC_GRACE: "mechanic_grace_period",
    MECHANIC_USD: "mechanic_usd_limit",
  };

  it("the example's mechanic/full literals equal both reusables' input defaults", () => {
    const reusable = inputDefaults(".github/workflows/review-reusable.yaml");
    const facade = inputDefaults(".github/workflows/review-on-comment-reusable.yaml");
    const example = exampleRouteLiterals();
    expect(reusable["mechanic_time_limit"]).toBe(example.mechanic);
    expect(reusable["mechanic_grace_period"]).toBe(example.mechanicGrace);
    expect(reusable["full_review_time_limit"]).toBe(example.full);
    expect(reusable["full_review_grace_period"]).toBe(example.fullGrace);
    // The example carries ONE shared cap modeled on the full route's; per-route USD inputs in the
    // reusables stay independently retunable (their agreement is pinned below, not their equality
    // with the example).
    expect(reusable["full_review_usd_limit"]).toBe(example.usd);
    // The two reusables must agree with each other on every budget default.
    for (const key of [
      "mechanic_time_limit",
      "mechanic_grace_period",
      "mechanic_usd_limit",
      "full_review_time_limit",
      "full_review_grace_period",
      "full_review_usd_limit",
    ]) {
      expect(facade[key], key).toBe(reusable[key]);
    }
  });

  it("every env-coercion fallback equals its input default — an unset consumer var receives the default, not a drift", () => {
    const reusable = inputDefaults(".github/workflows/review-reusable.yaml");
    const fallbacks = envCoercionFallbacks(".github/workflows/review-reusable.yaml");
    for (const [envKey, inputKey] of Object.entries(ENV_TO_INPUT)) {
      expect(fallbacks[envKey], envKey).toBe(reusable[inputKey]);
    }
  });
});
