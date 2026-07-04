#!/usr/bin/env node
// CLI entry point — citty subcommands for render, inline, cost, validate.

/* eslint-disable @typescript-eslint/require-await */
// citty requires async run() even when the body has no explicit await

import { defineCommand, runMain } from "citty";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Either } from "fp-ts/Either";
import { render } from "./render.js";
import { buildInlineComments, renderStraysSection } from "./inline.js";
import { computeCost } from "./cost.js";
import { validateFindings, unsafeUnwrap } from "./validate.js";
import { ResultEnvelopeCodec, FindingsCodec, PriceMapCodec } from "./schema.js";
import { post } from "./post.js";

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

// ---- render ----

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
      description: "Path to Eta template file",
      required: true,
    },
    usage: {
      type: "string",
      description: "Path to result envelope JSON (from agent CLI)",
      required: true,
    },
    prices: {
      type: "string",
      description: "Path to price map JSON",
      required: true,
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
  },
  run: async ({ args }) => {
    const findings = decode(FindingsCodec.decode(readJSON(args.findings)), "findings");
    const envelope = decode(ResultEnvelopeCodec.decode(readJSON(args.usage)), "envelope");
    const prices = decode(PriceMapCodec.decode(readJSON(args.prices)), "prices");
    const template = readFileSync(resolve(args.template), "utf-8");
    const output = render({
      findings,
      envelope,
      prices,
      template,
      reviewedSha: args["reviewed-sha"],
      route: args.route,
    });
    process.stdout.write(output);
  },
});

// ---- inline ----

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

// ---- cost ----

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

// ---- validate ----

const validateCmd = defineCommand({
  meta: {
    name: "validate",
    description: "Validate findings JSON against the canonical schema",
  },
  args: {
    findings: {
      type: "positional",
      description: "Path to findings JSON",
      required: true,
    },
    schema: {
      type: "string",
      description: "Path to findings schema (default: schema/findings.schema.json)",
    },
  },
  run: async ({ args }) => {
    const schemaPath = args.schema
      ? resolve(args.schema)
      : resolve(import.meta.dirname, "..", "schema", "findings.schema.json");
    const findingsRaw = readJSON(args.findings);
    const { valid, errors } = validateFindings(findingsRaw, schemaPath);
    if (valid) {
      process.stdout.write("✅ valid\n");
    } else {
      process.stderr.write("❌ invalid\n");
      for (const e of errors) process.stderr.write(`  - ${e}\n`);
      process.exit(1);
    }
  },
});

// ---- post ----

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
      description: "Path to price map JSON",
      required: true,
    },
    template: {
      type: "string",
      description: "Path to Eta template file for the summary comment",
      required: true,
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
  },
  run: async ({ args }) => {
    await post({
      repo: args.repo,
      headSha: args["head-sha"],
      botLogin: args["bot-login"] || "github-actions[bot]",
      findingsPath: args.findings,
      envelopePath: args.usage,
      pricesPath: args.prices,
      templatePath: args.template,
      route: args.route,
      headBranch: args["head-branch"],
    });
  },
});

// ---- main ----

const main = defineCommand({
  meta: {
    name: "code-review",
    version: "0.1.0",
    description:
      "Deterministic commenter for agentic PR review — render, inline, post, cost, and validate findings JSON",
  },
  subCommands: {
    render: renderCmd,
    inline: inlineCmd,
    post: postCmd,
    cost: costCmd,
    validate: validateCmd,
  },
});

await runMain(main);
