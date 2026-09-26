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

describe("full-review prompt — the vocabulary defers to the schema channel", () => {
  // The full-review prompt once taught the draft's field names and schema_version inline; the
  // #251 retrain made it defer BOTH to the schema the pipeline writes to $SCHEMA_FILE — whose
  // schema_version pattern is narrowed to the in-force minor — and to the installed CLI's
  // default-version command for the stamp, so a future rename or version bump needs no prompt edit
  // at all, and the prompt can never teach vocabulary the live gate rejects. These tests pin the
  // deferral: the prompt must NOT embed the vocabulary, must point at the schema's narrowed pattern
  // and the default-version note, and both copies must stay byte-identical modulo the reusable's
  // $INSTRUCTION_BLOCK splice. The argument is extracted as one unit (quote to closing quote — it
  // spans three physical lines), so a reflow cannot silently escape the pins.
  const promptArg = (workflowPath: string): string => {
    const scripts = runScripts(workflowPath)
      .map(({ script }) => script)
      .filter((script) => script.includes('--append-system-prompt "'));
    expect(scripts, `${workflowPath} prompt script`).toHaveLength(1);
    const script = scripts[0]!;
    const start = script.indexOf('--append-system-prompt "') + '--append-system-prompt "'.length;
    // The closing quote is the ONLY bare quote followed by the line continuation — anchored to the
    // shell-word boundary (quote + space + backslash at end of line) so a mid-argument occurrence
    // fails the test instead of silently truncating the argument the negative pins then read.
    const match = /" \\\n/.exec(script.slice(start));
    expect(match, `${workflowPath} prompt closing quote`).not.toBeNull();
    return script.slice(start, start + match!.index);
  };

  it("both files carry the same prompt argument, modulo the reusable's $INSTRUCTION_BLOCK splice", () => {
    const reusable = promptArg(".github/workflows/review-reusable.yaml").replace(
      "$INSTRUCTION_BLOCK",
      "",
    );
    const example = promptArg("examples/workflows/review.yaml");
    expect(reusable.length).toBeGreaterThan(1000);
    expect(example).toBe(reusable);
    // The argument must run to its known terminators — a truncating extraction fails here instead
    // of letting the negative pins below pass vacuously.
    expect(promptArg("examples/workflows/review.yaml").endsWith("$LOG_SUBSET_NOTE")).toBe(true);
    expect(promptArg(".github/workflows/review-reusable.yaml").endsWith("$INSTRUCTION_BLOCK")).toBe(
      true,
    );
  });

  it("the prompt defers the schema_version stamp and the field names to the schema channel", () => {
    const arg = promptArg(".github/workflows/review-reusable.yaml");
    expect(arg).toContain(
      `stamp \\\`schema_version\\\` with the exact in-force version$VERSION_NOTE`,
    );
    expect(arg).toContain(`use that schema's exact field names`);
    expect(arg).toContain(`each item using the schema's systemic_problems fields`);
    expect(arg).toContain(`into the schema's role buckets`);
  });

  it("both files read VERSION_NOTE from the installed CLI's default-version — the frozen fallback is the only literal", () => {
    const noteLines = (workflowPath: string): readonly string[] =>
      runScripts(workflowPath)
        .flatMap(({ script }) => script.split("\n"))
        .map((line) => line.trim())
        .filter((line) => line.startsWith('VERSION_NOTE="'));
    const scripts = (workflowPath: string): readonly string[] =>
      runScripts(workflowPath).map(({ script }) => script);
    for (const workflowPath of [
      ".github/workflows/review-reusable.yaml",
      "examples/workflows/review.yaml",
    ]) {
      const notes = noteLines(workflowPath);
      expect(notes, workflowPath).toHaveLength(2);
      // The version is READ from the installed CLI (default-version prints the registry's own
      // default — the same value the gate resolves); the only literal anywhere is the FROZEN
      // pre-command fallback, reachable only by CLIs whose registries stop at that version.
      const [frozen, read] = notes[0]!.includes("0.10.0")
        ? [notes[0]!, notes[1]!]
        : [notes[1]!, notes[0]!];
      expect(frozen, workflowPath).toContain(`\\\`0.10.0\\\``);
      expect(read, workflowPath).not.toMatch(/[0-9]\.[0-9]+\.[0-9]/);
      expect(
        scripts(workflowPath).some((s) => s.includes("code-review default-version 2>/dev/null")),
        workflowPath,
      ).toBe(true);
    }
    expect(noteLines("examples/workflows/review.yaml")).toEqual(
      noteLines(".github/workflows/review-reusable.yaml"),
    );
  });

  it("the prompt teaches no vocabulary the schema could contradict — no inline field lists, no version literal", () => {
    const arg = promptArg(".github/workflows/review-reusable.yaml");
    expect(arg).not.toContain("(optional: ");
    expect(arg).not.toContain("each item using title,");
    expect(arg).not.toContain("Set the required");
    expect(arg).not.toContain("Each finding uses these exact field names");
    expect(arg).not.toMatch(/\\"schema_version\\": \\"[0-9]/);
  });

  it("the prompt still warns against the retired code/finding_codes spellings and names the one surviving code", () => {
    const arg = promptArg(".github/workflows/review-reusable.yaml");
    expect(arg).toContain(`the retired \\\`code\\\`/\\\`finding_codes\\\` field names`);
    expect(arg).toContain(`renamed to \\\`id\\\`/\\\`finding_ids\\\``);
    expect(arg).toContain(`\\\`change_size.code\\\` is the one surviving \\\`code\\\``);
  });
});

describe("path plumbing — the reusable and the example hand-mirror the staging directories byte-for-byte", () => {
  // The two workflow copies hand-mirror every path-plumbing change (GATHER_DIR/FINDINGS_DIR
  // assignments, the GITHUB_ENV writes, the transcripts and --add-dir lines, the upload paths).
  // A half-applied edit diverges them silently — the #254 round-3 review found exactly that (the
  // example's transcripts cp) — so the plumbing lines are pinned byte-identical here, the same
  // discipline the mechanic steer lines already have.
  const PLUMBING_RE =
    /(GATHER_DIR|FINDINGS_DIR|GITHUB_ENV|transcripts\/|--add-dir|posted=true|steps\.post\.outputs\.posted|needs\.comment\.result|needs\.comment\.outputs\.posted|COMMENT_RESULT|REVIEW_RESULT|POSTED:|env\.FINDINGS_DIR|runner\.temp)/;
  const plumbingLines = (workflowPath: string): readonly string[] =>
    readRepoFile(workflowPath)
      .split("\n")
      .map((line) => line.trim())
      // Comment lines are excluded — prose may legitimately differ; only the commands, conditions,
      // and expressions are pinned byte-identical.
      .filter((line) => PLUMBING_RE.test(line) && !line.startsWith("#"))
      .sort();

  it("every path-plumbing line is byte-identical between review-reusable.yaml and the example", () => {
    const reusable = plumbingLines(".github/workflows/review-reusable.yaml");
    const example = plumbingLines("examples/workflows/review.yaml");
    expect(reusable.length).toBeGreaterThan(10);
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
