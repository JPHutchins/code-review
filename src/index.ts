#!/usr/bin/env node
// CLI entry point — citty subcommands for render, inline, post, cost, validate, adapt, extract, print-schema.

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
import type { Triage } from "./schema.js";
import { post } from "./post.js";
import { adapt, isAdapterName } from "./adapt.js";
import type { AdapterName } from "./adapt.js";
import { extractStructured, describeLadderFailure } from "./extract.js";
import type { ExtractKind, LadderOutcome } from "./extract.js";
import { schemaPathFor } from "./registry.js";
import type { SchemaKind } from "./registry.js";

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
      description: 'Review route label (e.g. "full review" or "mechanic")',
      required: true,
    },
    effort: {
      type: "string",
      description:
        'Effort label to render in the route line (e.g. "max" or "low"); omitted when absent',
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
    const { comments, strays } = buildInlineComments(findings.findings, diff, inlineTemplate);
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
  },
  run: async ({ args }) => {
    const envelope = unwrapAdapt(
      adapt(requireAdapterName(args.adapter), readJSON(args.native), args["agent-file"]),
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
    const outcome = extractStructured({
      kind,
      native: readJSON(args.native),
      agentFilePath: args["agent-file"],
    });

    if (outcome.kind === "ok") {
      process.stdout.write(`${JSON.stringify(outcome.candidate, null, 2)}\n`);
      return;
    }
    if (kind === "triage") {
      process.stdout.write(`${JSON.stringify(failClosedTriage(outcome), null, 2)}\n`);
      return;
    }
    fail(describeLadderFailure(outcome));
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
    description: "Print a bundled schema JSON",
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
    process.stdout.write(readFileSync(schemaPath, "utf-8"));
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
      description: 'Review route label (e.g. "full review" or "mechanic")',
      required: true,
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
        'Effort label to render in the route line (e.g. "max" or "low"); omitted when absent',
    },
    "test-report": {
      type: "string",
      description: TEST_REPORT_DESCRIPTION,
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
    });
  },
});

export const main = defineCommand({
  meta: {
    name: "code-review",
    version: "0.1.0",
    description:
      "Deterministic commenter for agentic PR review — render, inline, post, adapt, extract, cost, and validate findings JSON",
  },
  subCommands: {
    render: renderCmd,
    inline: inlineCmd,
    post: postCmd,
    cost: costCmd,
    validate: validateCmd,
    adapt: adaptCmd,
    extract: extractCmd,
    "print-schema": printSchemaCmd,
  },
});

// Skip auto-invocation under the test runner — tests drive `main` directly via citty's runCommand.
if (!process.env["VITEST"]) {
  await runMain(main);
}
