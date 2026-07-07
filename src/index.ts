#!/usr/bin/env node
// CLI entry point — citty subcommands for render, inline, post, cost, validate, adapt, extract,
// lower-suggestions, print-schema, stop-gate.

/* eslint-disable @typescript-eslint/require-await */
// citty requires async run() even when the body has no explicit await

import { defineCommand, runMain } from "citty";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Either } from "fp-ts/Either";
import { render } from "./render.js";
import { buildInlineComments, renderStraysSection } from "./inline.js";
import { computeCost } from "./cost.js";
import { validateAgainstSchema, unsafeUnwrap } from "./validate.js";
import { ResultEnvelopeCodec, FindingsCodec, PriceMapCodec, TestSummaryCodec } from "./schema.js";
import type { Triage, Finding } from "./schema.js";
import { post } from "./post.js";
import { gather, renderOutputs } from "./gather.js";
import { adapt, isAdapterName } from "./adapt.js";
import type { AdapterName } from "./adapt.js";
import { extractStructured, describeLadderFailure, ladderFailureDiagnostics } from "./extract.js";
import type { ExtractKind, LadderOutcome } from "./extract.js";
import { schemaPathFor } from "./registry.js";
import type { SchemaKind } from "./registry.js";
import { lowerPatch } from "./patch.js";
import {
  decideGate,
  draftState,
  readNudges,
  bumpNudges,
  defaultHookCommand,
  stopHookSettings,
} from "./stop-gate.js";

const readJSON = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf-8")) as unknown;
  } catch (err) {
    fail(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error("unreachable", { cause: err }); // fail() always exits
  }
};

const fail = (msg: string): never => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};

const decode = <A>(either: Either<unknown, A>, label: string): A => {
  try {
    return unsafeUnwrap(either);
  } catch {
    fail(`${label} does not match expected shape`);
  }
  throw new Error("unreachable"); // fail() always exits
};

/** Unwrap an adapter's Either, surfacing its own message rather than a generic one. */
const unwrapAdapt = <A>(either: Either<string, A>): A => {
  try {
    if (either._tag === "Left") throw new Error(either.left);
    return either.right;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  throw new Error("unreachable"); // fail() always exits
};

/** Resolve a path bundled with the package (schema/, templates/) — same pattern as validate's default schema. */
const bundledPath = (...segments: string[]): string =>
  resolve(import.meta.dirname, "..", ...segments);

const packageVersion = (
  JSON.parse(readFileSync(bundledPath("package.json"), "utf-8")) as { version: string }
).version;

/** `--template` defaults to the bundled comment template when omitted. */
const resolveTemplatePath = (templateArg: string | undefined): string =>
  templateArg ? resolve(templateArg) : bundledPath("templates", "comment.eta");

/** `--prices` defaults to the bundled (all-zero) example prices when omitted, with a warning. */
const resolvePricesPath = (pricesArg: string | undefined): string => {
  if (pricesArg) return resolve(pricesArg);
  process.stderr.write(
    "code-review: no --prices given — using the bundled example prices (all zero); cost figures will be $0\n",
  );
  return bundledPath("schema", "prices.example.json");
};

const TEST_REPORT_DESCRIPTION =
  'Path to a JSON test summary: {"passed": number, "failed": number, "total": number, "failures"?: [{"name": string, "message"?: string}]}';

const renderCmd = defineCommand({
  meta: {
    name: "render",
    description: "Render a code-review comment from findings + usage + prices",
  },
  args: {
    findings: {
      type: "positional",
      description: "Path to findings JSON",
      required: true,
    },
    template: {
      type: "string",
      description: "Path to Eta template file (default: bundled templates/comment.eta)",
    },
    usage: {
      type: "string",
      description: "Path to result envelope JSON (from agent CLI)",
      required: true,
    },
    prices: {
      type: "string",
      description:
        "Path to price map JSON (default: bundled schema/prices.example.json — all zero)",
    },
    "reviewed-sha": {
      type: "string",
      description: "SHA of the last reviewed commit",
    },
    route: {
      type: "string",
      description:
        "Review route label; overrides the envelope's route when set (default: read from the envelope)",
    },
    effort: {
      type: "string",
      description:
        "Effort label; overrides the envelope's effort when set (default: read from the envelope)",
    },
    "test-report": {
      type: "string",
      description: TEST_REPORT_DESCRIPTION,
    },
  },
  run: async ({ args }) => {
    const findings = decode(FindingsCodec.decode(readJSON(args.findings)), "findings");
    const envelope = decode(ResultEnvelopeCodec.decode(readJSON(args.usage)), "envelope");
    const templatePath = resolveTemplatePath(args.template);
    const pricesPath = resolvePricesPath(args.prices);
    const prices = decode(PriceMapCodec.decode(readJSON(pricesPath)), "prices");
    const template = readFileSync(templatePath, "utf-8");
    const testReport = args["test-report"]
      ? decode(TestSummaryCodec.decode(readJSON(args["test-report"])), "test report")
      : undefined;
    const output = render({
      findings,
      envelope,
      prices,
      template,
      reviewedSha: args["reviewed-sha"],
      route: args.route,
      effort: args.effort,
      testReport,
    });
    process.stdout.write(output);
  },
});

const inlineCmd = defineCommand({
  meta: {
    name: "inline",
    description: "Build GitHub reviews comments[] payload from findings + diff",
  },
  args: {
    findings: {
      type: "positional",
      description: "Path to findings JSON",
      required: true,
    },
    diff: {
      type: "string",
      description: "Path to PR diff file",
      required: true,
    },
    template: {
      type: "string",
      description: "Path to inline comment Eta template (default: built-in format)",
    },
  },
  run: async ({ args }) => {
    const findings = decode(FindingsCodec.decode(readJSON(args.findings)), "findings");
    const diff = readFileSync(resolve(args.diff), "utf-8");
    const inlineTemplate = args.template
      ? readFileSync(resolve(args.template), "utf-8")
      : undefined;
    const { comments, strays } = buildInlineComments(findings.findings, diff, { inlineTemplate });
    process.stdout.write(
      JSON.stringify({ comments, strays, stray_markdown: renderStraysSection(strays) }, null, 2),
    );
  },
});

const costCmd = defineCommand({
  meta: {
    name: "cost",
    description: "Recompute USD cost from the envelope's models array + price map",
  },
  args: {
    envelope: {
      type: "positional",
      description: "Path to result envelope JSON",
      required: true,
    },
    prices: {
      type: "string",
      description: "Path to price map JSON",
      required: true,
    },
  },
  run: async ({ args }) => {
    const envelope = decode(ResultEnvelopeCodec.decode(readJSON(args.envelope)), "envelope");
    const prices = decode(PriceMapCodec.decode(readJSON(args.prices)), "prices");
    const report = computeCost(envelope.models, prices);
    process.stdout.write(JSON.stringify(report, null, 2));
  },
});

/** A document's declared `schema_version`, when present as a string (mirrors registry.ts's check). */
const declaredSchemaVersion = (raw: unknown): string | undefined =>
  typeof raw === "object" && raw !== null && "schema_version" in raw
    ? typeof raw.schema_version === "string"
      ? raw.schema_version
      : undefined
    : undefined;

/** The version to derive when neither --schema nor --schema-version is given: findings carries its
 *  version in-data; triage/prices have no in-data signal (see registry.ts), so undefined selects the
 *  registry default (latest) for the kind. */
const derivedSchemaVersion = (kind: SchemaKind, raw: unknown): string | undefined =>
  kind === "findings" ? declaredSchemaVersion(raw) : undefined;

const validateCmd = defineCommand({
  meta: {
    name: "validate",
    description: "Validate a findings/triage/prices JSON document against the canonical schema",
  },
  args: {
    document: {
      type: "positional",
      description: "Path to the JSON document to validate (of the given --kind)",
      required: true,
    },
    kind: {
      type: "string",
      description:
        "Schema kind to validate against: findings | triage | prices (default: findings)",
    },
    schema: {
      type: "string",
      description:
        "Path to a schema file (wins over --kind; default: the bundled schema derived from --kind, --schema-version, the document's declared schema_version, or the bundled latest)",
    },
    "schema-version": {
      type: "string",
      description:
        "Schema major.minor version to validate against (default: the document's declared schema_version for findings, or the kind's latest)",
    },
  },
  run: async ({ args }) => {
    const kind = requireSchemaKind(args.kind || "findings");
    const documentRaw = readJSON(args.document);
    const schemaPath = args.schema
      ? resolve(args.schema)
      : requireSchemaPath(kind, args["schema-version"] || derivedSchemaVersion(kind, documentRaw));
    const { valid, errors } = validateAgainstSchema(documentRaw, schemaPath);
    if (valid) {
      process.stdout.write("✅ valid\n");
    } else {
      process.stderr.write("❌ invalid\n");
      for (const e of errors) process.stderr.write(`  - ${e}\n`);
      process.exit(1);
    }
  },
});

const adaptCmd = defineCommand({
  meta: {
    name: "adapt",
    description: "Map a native agent-CLI result envelope onto the abstract SPEC §6.1 envelope",
  },
  args: {
    native: {
      type: "positional",
      description: "Path to the native result envelope JSON (from the agent CLI)",
      required: true,
    },
    adapter: {
      type: "string",
      description: 'Adapter to use (currently: "claude-code")',
      required: true,
    },
    "agent-file": {
      type: "string",
      description:
        "Path to a file the agent was told to write its own validated findings JSON to (wins over the native envelope's structured_output/result when it validates)",
    },
    route: {
      type: "string",
      description:
        'Review route label to stamp into the envelope (e.g. "full review" or "mechanic")',
    },
    effort: {
      type: "string",
      description: 'Effort label to stamp into the envelope (e.g. "max" or "low")',
    },
  },
  run: async ({ args }) => {
    const envelope = unwrapAdapt(
      adapt(requireAdapterName(args.adapter), readJSON(args.native), args["agent-file"], {
        route: args.route,
        effort: args.effort,
      }),
    );
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  },
});

const isExtractSchemaKind = (s: string): s is ExtractKind => s === "findings" || s === "triage";

/** Narrow to a schema kind the extraction ladder supports (no "prices" — unlike print-schema's),
 *  or fail with a clear message (never falls through). */
const requireExtractSchemaKind = (name: string): ExtractKind => {
  if (isExtractSchemaKind(name)) return name;
  fail(`Unknown kind "${name}" for extract — expected one of: findings, triage`);
  throw new Error("unreachable"); // fail() always exits
};

/** Fail-closed triage synthesized when the ladder can't recover a validated triage verdict — never
 *  defaults to safe (§7.3). */
const failClosedTriage = (outcome: Exclude<LadderOutcome, { kind: "ok" }>): Triage => ({
  safe: false,
  reasons: describeLadderFailure(outcome),
});

const extractCmd = defineCommand({
  meta: {
    name: "extract",
    description:
      "Recover findings/triage JSON from a native agent-CLI result envelope via the deterministic extraction ladder",
  },
  args: {
    native: {
      type: "positional",
      description: "Path to the native result envelope JSON (from the agent CLI)",
      required: true,
    },
    adapter: {
      type: "string",
      description: 'Adapter whose native envelope shape to extract from (currently: "claude-code")',
      required: true,
    },
    kind: {
      type: "string",
      description: "Schema kind to extract: findings | triage",
      required: true,
    },
    "agent-file": {
      type: "string",
      description:
        "Path to a file the agent was told to write its own validated JSON to (findings only — a documented no-op for triage)",
    },
  },
  run: async ({ args }) => {
    requireAdapterName(args.adapter);
    const kind = requireExtractSchemaKind(args.kind);
    const input = { kind, native: readJSON(args.native), agentFilePath: args["agent-file"] };
    const outcome = extractStructured(input);

    if (outcome.kind === "ok") {
      process.stdout.write(`${JSON.stringify(outcome.candidate, null, 2)}\n`);
      return;
    }
    // A recovery miss is otherwise opaque (only the generic reason reaches the comment); trace what
    // each rung saw to stderr so the CI log alone explains the failure — no local repro needed.
    if (outcome.kind === "none" || outcome.kind === "ambiguous") {
      process.stderr.write(`extract: recovery failed —\n${ladderFailureDiagnostics(input)}\n`);
    }
    if (kind === "triage") {
      process.stdout.write(`${JSON.stringify(failClosedTriage(outcome), null, 2)}\n`);
      return;
    }
    fail(describeLadderFailure(outcome));
  },
});

/** `finding` with its `patch` field removed — a fresh shallow copy, `finding` itself untouched. */
const withoutPatch = (finding: Finding): Finding => {
  const copy = { ...finding };
  delete copy.patch;
  return copy;
};

/** A file's lines, LF-split and without a trailing-newline artifact entry; null when unreadable. */
const readFileLines = (path: string): readonly string[] | null => {
  try {
    const rawLines = readFileSync(path, "utf-8").split("\n");
    return rawLines.length > 0 && rawLines[rawLines.length - 1] === ""
      ? rawLines.slice(0, -1)
      : rawLines;
  } catch {
    return null;
  }
};

/** Lower one finding's `patch` (when present) into a `suggestion` + exact range, validated against
 *  the real file at `<repoRoot>/<finding.path>`; drop the patch (logging why to stderr) when the
 *  file can't be read or the patch doesn't apply cleanly. Findings without a `patch` pass through
 *  untouched. Never throws. */
const lowerFinding = (finding: Finding, repoRoot: string): Finding => {
  if (finding.patch === undefined) return finding;
  const base = withoutPatch(finding);
  const lines = readFileLines(resolve(repoRoot, finding.path));
  if (lines === null) {
    process.stderr.write(
      `lower-suggestions: ${finding.path}: could not read file at "${repoRoot}" — dropping patch\n`,
    );
    return base;
  }
  const result = lowerPatch(finding.patch, lines);
  if (result.kind === "drop") {
    process.stderr.write(
      `lower-suggestions: ${finding.path}:${String(finding.start_line)}: ${result.reason} — dropping patch\n`,
    );
    return base;
  }
  return {
    ...base,
    suggestion: result.suggestion,
    start_line: result.startLine,
    end_line: result.endLine,
  };
};

const lowerSuggestionsCmd = defineCommand({
  meta: {
    name: "lower-suggestions",
    description:
      "Validate each finding's patch against the real PR-head tree and lower it to an exact suggestion + range, or drop it (issue #10)",
  },
  args: {
    findings: {
      type: "positional",
      description: "Path to findings JSON",
      required: true,
    },
    "repo-root": {
      type: "string",
      description:
        "Directory to resolve each finding's path against — the review job's checked-out, clean PR-head tree (default: .)",
    },
  },
  run: async ({ args }) => {
    const findings = decode(FindingsCodec.decode(readJSON(args.findings)), "findings");
    const repoRoot = args["repo-root"] ? resolve(args["repo-root"]) : process.cwd();
    const lowered = {
      ...findings,
      findings: findings.findings.map((f) => lowerFinding(f, repoRoot)),
    };
    process.stdout.write(`${JSON.stringify(lowered, null, 2)}\n`);
  },
});

/** Narrow to a known adapter name, or fail with a clear message (never falls through). */
const requireAdapterName = (name: string): AdapterName => {
  if (isAdapterName(name)) return name;
  fail(`Unknown adapter "${name}" — supported: claude-code`);
  throw new Error("unreachable"); // fail() always exits
};

const isSchemaKind = (s: string): s is SchemaKind =>
  s === "findings" || s === "triage" || s === "prices";

/** Narrow to a known schema kind, or fail with a clear message (never falls through). */
const requireSchemaKind = (name: string): SchemaKind => {
  if (isSchemaKind(name)) return name;
  fail(`Unknown schema "${name}" — expected one of: findings, triage, prices`);
  throw new Error("unreachable"); // fail() always exits
};

/** Resolve a bundled schema path via the registry, or fail listing what's supported. */
const requireSchemaPath = (kind: SchemaKind, version: string | undefined): string => {
  try {
    return schemaPathFor(kind, version);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  throw new Error("unreachable"); // fail() always exits
};

const printSchemaCmd = defineCommand({
  meta: {
    name: "print-schema",
    description:
      "Print a bundled schema JSON, ready to hand to a CLI's --json-schema (the $schema draft declaration is stripped)",
  },
  args: {
    name: {
      type: "positional",
      description: "Schema to print: findings | triage | prices",
      required: true,
    },
    "schema-version": {
      type: "string",
      description: "Schema major.minor version to print (default: latest)",
    },
  },
  run: async ({ args }) => {
    const schemaKind = requireSchemaKind(args.name);
    const schemaPath = requireSchemaPath(schemaKind, args["schema-version"]);
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as Record<string, unknown>;
    // `claude -p --json-schema` silently disables structured-output enforcement when the schema
    // carries a top-level `$schema` draft declaration — `structured_output` comes back null and the
    // model guesses field names. The canonical file keeps `$schema` for validators; the form handed
    // to a CLI must omit it. `$id`/`title` are tolerated and kept.
    const enforcementSchema = Object.fromEntries(
      Object.entries(schema).filter(([key]) => key !== "$schema"),
    );
    process.stdout.write(`${JSON.stringify(enforcementSchema, null, 2)}\n`);
  },
});

const MAX_NUDGES_DEFAULT = 5;

/** Drain the Stop-hook payload delivered on stdin so the caller never sees EPIPE; its content is
 *  not needed — the decision comes from the draft on disk. Absent stdin (a manual run) is fine. */
const drainStdin = (): void => {
  try {
    readFileSync(0);
  } catch {
    // no stdin
  }
};

const parseNonNegativeInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

const stopGateCmd = defineCommand({
  meta: {
    name: "stop-gate",
    description:
      "Claude Code Stop-hook gate: refuse to let the agent end its turn until --draft validates against the schema (bounded by --max-nudges). With --print-settings, emit the --settings JSON that wires this as the Stop hook.",
  },
  args: {
    draft: {
      type: "string",
      description: "Path to the findings document the agent must produce and keep valid",
      required: true,
    },
    kind: {
      type: "string",
      description:
        "Schema kind to validate against: findings | triage | prices (default: findings)",
    },
    schema: { type: "string", description: "Path to a schema file (wins over --kind)" },
    "schema-version": {
      type: "string",
      description: "Schema major.minor to validate against (default: the draft's declared version)",
    },
    "max-nudges": {
      type: "string",
      description: `Times to block before relenting so the step fails downstream as before (default: ${MAX_NUDGES_DEFAULT})`,
    },
    counter: {
      type: "string",
      description: "Path for the nudge counter (default: <draft>.nudges)",
    },
    "print-settings": {
      type: "boolean",
      description: "Print the Stop-hook settings JSON that wires this gate, then exit",
    },
  },
  run: async ({ args }) => {
    const draftPath = resolve(args.draft);

    if (args["print-settings"]) {
      const command = defaultHookCommand(draftPath, {
        kind: args.kind,
        schemaVersion: args["schema-version"],
        maxNudges: args["max-nudges"],
      });
      process.stdout.write(`${JSON.stringify(stopHookSettings(command))}\n`);
      return;
    }

    drainStdin();

    const kind = requireSchemaKind(args.kind || "findings");
    const maxNudges = parseNonNegativeInt(args["max-nudges"], MAX_NUDGES_DEFAULT);
    const counterPath = args.counter ? resolve(args.counter) : `${draftPath}.nudges`;

    // schemaPathFor throws (rather than the process-exiting requireSchemaPath) so that a draft
    // declaring an unsupported schema_version is caught by draftState and treated as invalid —
    // i.e. a block with a helpful message — instead of crashing the hook and letting the agent stop.
    const state = draftState(draftPath, (parsed) =>
      args.schema
        ? resolve(args.schema)
        : schemaPathFor(kind, args["schema-version"] || derivedSchemaVersion(kind, parsed)),
    );

    const nudges = readNudges(counterPath);
    const decision = decideGate(state, nudges, maxNudges, draftPath);
    if (decision.kind === "block") {
      bumpNudges(counterPath, nudges);
      process.stdout.write(`${JSON.stringify({ decision: "block", reason: decision.reason })}\n`);
    }
  },
});

const gatherCmd = defineCommand({
  meta: {
    name: "gather",
    description:
      "Resolve the PR from the CI head SHA and gather review inputs (diff with git-diff fallback, PR context, prior bot review, failing-job logs) as files for the review agent",
  },
  args: {
    repo: { type: "string", description: "Repository (owner/name)", required: true },
    "head-sha": {
      type: "string",
      description: "Trusted head SHA to resolve the PR (from workflow_run.head_sha)",
      required: true,
    },
    "head-branch": {
      type: "string",
      description: "Head branch to disambiguate the PR when multiple share a commit",
    },
    "run-id": {
      type: "string",
      description:
        "CI run id (from workflow_run.id); its failing jobs' logs are downloaded on failure",
      required: true,
    },
    conclusion: {
      type: "string",
      description:
        "CI conclusion (e.g. success | failure); failure triggers failing-job log download",
      required: true,
    },
    "bot-login": {
      type: "string",
      description:
        "Bot login whose last PR comment is captured as prior review (default: github-actions[bot])",
    },
    "out-dir": {
      type: "string",
      description: "Directory to write gathered files into (default: current directory)",
    },
  },
  run: async ({ args }) => {
    const result = await gather({
      repo: args.repo,
      headSha: args["head-sha"],
      headBranch: args["head-branch"],
      runId: args["run-id"],
      conclusion: args.conclusion,
      botLogin: args["bot-login"] || "github-actions[bot]",
      outDir: args["out-dir"] ? resolve(args["out-dir"]) : process.cwd(),
    });
    process.stdout.write(renderOutputs(result));
  },
});

const postCmd = defineCommand({
  meta: {
    name: "post",
    description:
      "Post a complete review (inline comments + sticky summary) from findings + envelope + diff",
  },
  args: {
    findings: {
      type: "positional",
      description: "Path to findings JSON",
      required: true,
    },
    "head-sha": {
      type: "string",
      description: "Trusted head SHA to resolve the PR (from workflow_run.head_sha)",
      required: true,
    },
    repo: {
      type: "string",
      description: "Repository (owner/name)",
      required: true,
    },
    usage: {
      type: "string",
      description: "Path to result envelope JSON (from agent CLI)",
      required: true,
    },
    prices: {
      type: "string",
      description:
        "Path to price map JSON (default: bundled schema/prices.example.json — all zero)",
    },
    template: {
      type: "string",
      description:
        "Path to Eta template file for the summary comment (default: bundled templates/comment.eta)",
    },
    "inline-template": {
      type: "string",
      description: "Path to inline comment Eta template (default: built-in format)",
    },
    route: {
      type: "string",
      description:
        "Review route label; overrides the envelope's route when set (default: read from the envelope)",
    },
    "bot-login": {
      type: "string",
      description: "Bot login to trust for sticky comment upsert (default: github-actions[bot])",
    },
    "head-branch": {
      type: "string",
      description: "Head branch to disambiguate PR when multiple share a commit",
    },
    effort: {
      type: "string",
      description:
        "Effort label; overrides the envelope's effort when set (default: read from the envelope)",
    },
    "test-report": {
      type: "string",
      description: TEST_REPORT_DESCRIPTION,
    },
    "run-url": {
      type: "string",
      description:
        "Workflow run URL (transcript/traces), rendered as a link in the LLM Disclosure aside",
    },
    "json-url": {
      type: "string",
      description:
        "URL to the machine-readable findings JSON artifact, pointed at from the sticky and each inline comment",
    },
  },
  run: async ({ args }) => {
    await post({
      repo: args.repo,
      headSha: args["head-sha"],
      botLogin: args["bot-login"] || "github-actions[bot]",
      findingsPath: args.findings,
      envelopePath: args.usage,
      pricesPath: resolvePricesPath(args.prices),
      templatePath: resolveTemplatePath(args.template),
      inlineTemplatePath: args["inline-template"] ? resolve(args["inline-template"]) : undefined,
      route: args.route,
      headBranch: args["head-branch"],
      effort: args.effort,
      testReportPath: args["test-report"],
      runUrl: args["run-url"],
      jsonUrl: args["json-url"],
    });
  },
});

export const main = defineCommand({
  meta: {
    name: "code-review",
    version: packageVersion,
    description:
      "Deterministic commenter for agentic PR review — gather, render, inline, post, adapt, extract, lower-suggestions, cost, validate, and stop-gate findings JSON",
  },
  subCommands: {
    gather: gatherCmd,
    render: renderCmd,
    inline: inlineCmd,
    post: postCmd,
    cost: costCmd,
    validate: validateCmd,
    adapt: adaptCmd,
    extract: extractCmd,
    "lower-suggestions": lowerSuggestionsCmd,
    "print-schema": printSchemaCmd,
    "stop-gate": stopGateCmd,
  },
});

// Skip auto-invocation under the test runner — tests drive `main` directly via citty's runCommand.
if (!process.env["VITEST"]) {
  await runMain(main);
}
