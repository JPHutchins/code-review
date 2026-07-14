#!/usr/bin/env node
// CLI entry point — citty subcommands for render, inline, post, cost, check-cost, validate, adapt,
// extract, validate-patches, print-schema, stop-gate, budget-hook, print-settings, deadline.

/* eslint-disable @typescript-eslint/require-await */
// citty requires async run() even when the body has no explicit await

import { defineCommand, runMain } from "citty";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Either } from "fp-ts/Either";
import { render } from "./render.js";
import { buildInlineComments, renderStraysSection } from "./inline.js";
import { computeCost } from "./cost.js";
import { readTranscriptTree, sumTranscriptUsage } from "./transcript.js";
import {
  evaluateBudgetHook,
  parseWallMs,
  parseFraction,
  parseEpochSecMs,
  anchoredElapsedMs,
  deadlineEpochSec,
  mainHasWrittenDraft,
  seedMarkerPath,
  DEFAULT_RESERVE,
  DEADLINE_ENV,
} from "./budget.js";
import { validateAgainstSchema, unsafeUnwrap } from "./validate.js";
import { formatUtc } from "./format.js";
import {
  ResultEnvelopeCodec,
  FindingsCodec,
  PriceMapCodec,
  TestSummaryCodec,
  noticeFindings,
} from "./schema.js";
import type { Triage, Finding, PriceMap } from "./schema.js";
import { parseFindingsMarker } from "./surface.js";
import { post } from "./post.js";
import { gather, renderOutputs } from "./gather.js";
import { adapt, isAdapterName } from "./adapt.js";
import type { AdapterName, TranscriptTelemetry } from "./adapt.js";
import { extractStructured, describeLadderFailure, ladderFailureDiagnostics } from "./extract.js";
import type { ExtractKind, LadderOutcome } from "./extract.js";
import { schemaPathFor, declaredVersion } from "./registry.js";
import type { SchemaKind } from "./registry.js";
import { validatePatch } from "./patch.js";
import {
  decideGate,
  draftState,
  readNudges,
  bumpNudges,
  defaultHookCommand,
  stopHookSettings,
} from "./stop-gate.js";
import { composeReviewSettings } from "./settings.js";

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

/** Like `readJSON` but tolerant: returns `undefined` (never exits) when the file is unreadable,
 *  empty, or not valid JSON. Used ONLY for `adapt`'s native positional arg, which a wall-clock
 *  `timeout` kill can leave empty/truncated (issue #39) — `adapt` then degrades to a no-telemetry
 *  envelope and still recovers findings from `--agent-file`, instead of crashing the whole review
 *  step. Each degrade path names its specific cause on stderr — surfacing the real read error so an
 *  EACCES/EISDIR is not misreported as "empty" — to stay diagnosable; genuinely-required inputs keep
 *  the strict `readJSON`. */
const readJSONOrAbsent = (path: string): unknown => {
  const read = ((): { readonly text: string } | { readonly error: string } => {
    try {
      return { text: readFileSync(resolve(path), "utf-8") };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  })();
  if ("error" in read) {
    process.stderr.write(
      `code-review: native envelope ${path} could not be read (${read.error}) — proceeding with no native telemetry (issue #39)\n`,
    );
    return undefined;
  }
  if (read.text.trim() === "") {
    process.stderr.write(
      `code-review: native envelope ${path} is empty — proceeding with no native telemetry (issue #39)\n`,
    );
    return undefined;
  }
  try {
    return JSON.parse(read.text) as unknown;
  } catch (err) {
    process.stderr.write(
      `code-review: native envelope ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — proceeding with no native telemetry (issue #39)\n`,
    );
    return undefined;
  }
};

/** Read and parse the hook payload delivered on stdin, defensively: a TTY (manual run), absent stdin,
 *  or non-JSON all yield null. The budget hook then decides from its flags alone (no live signal),
 *  never crashing on a missing or malformed payload. */
const readStdinJSON = (): unknown => {
  if (process.stdin.isTTY) return null;
  const raw = ((): string => {
    try {
      return readFileSync(0, "utf-8");
    } catch {
      return "";
    }
  })();
  if (raw.trim() === "") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
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

/** Telemetry from a session transcript tree (main + subagents), which `adapt` uses for the true
 *  WALL + TURNS whenever it's available — the native envelope only sees the main agent and under-
 *  reports a subagent fan-out (issue #59) — and for per-model usage too on a wall-kill that left the
 *  native empty (issue #36), so cost computes from real models×prices instead of $0.00. A
 *  missing/unreadable transcript yields empty models + a zero span, which `adapt` treats as "no
 *  transcript" (keeping the native's own figures). */
const transcriptFallbackFrom = (path: string): TranscriptTelemetry => {
  const tree = readTranscriptTree(resolve(path));
  if (tree.missing)
    process.stderr.write(
      `code-review adapt: transcript ${path} is unreadable — no telemetry fallback (issue #36)\n`,
    );
  const usage = sumTranscriptUsage(tree.entries);
  return { models: usage.models, turns: usage.turns, durationMs: usage.durationMs };
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

/** `--inline-template` defaults to the bundled inline template when omitted (inline.eta is the
 *  per-surface SSOT — issue #22 — mirroring resolveTemplatePath's sticky default). */
const resolveInlineTemplatePath = (templateArg: string | undefined): string =>
  templateArg ? resolve(templateArg) : bundledPath("templates", "inline.eta");

/** Price-map resolution with explicit provenance: `provided` is a real caller-supplied map,
 *  `absent` is the bundled all-zero example standing in for one (loaded only to satisfy the codec /
 *  computeCost shape). The render layer is TOLD which, so it reports cost as N/A rather than a false
 *  $0.00 when absent (SPEC §6.2) — never inferring it from the path. */
type PriceResolution =
  | { readonly kind: "provided"; readonly path: string }
  | { readonly kind: "absent"; readonly path: string };

/** `--prices` defaults to the bundled (all-zero) example prices when omitted, with a warning. */
const resolvePrices = (pricesArg: string | undefined): PriceResolution => {
  if (pricesArg) return { kind: "provided", path: resolve(pricesArg) };
  process.stderr.write(
    "code-review: no --prices given — cost will be reported as N/A (no price map to recompute from)\n",
  );
  return { kind: "absent", path: bundledPath("schema", "prices.example.json") };
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
    const priceResolution = resolvePrices(args.prices);
    const prices = decode(PriceMapCodec.decode(readJSON(priceResolution.path)), "prices");
    const template = readFileSync(templatePath, "utf-8");
    const testReport = args["test-report"]
      ? decode(TestSummaryCodec.decode(readJSON(args["test-report"])), "test report")
      : undefined;
    const output = render({
      findings,
      envelope,
      prices,
      pricesProvided: priceResolution.kind === "provided",
      template,
      reviewedSha: args["reviewed-sha"],
      route: args.route,
      effort: args.effort,
      testReport,
      postedAt: formatUtc(new Date()),
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
      description: "Path to inline comment Eta template (default: bundled templates/inline.eta)",
    },
  },
  run: async ({ args }) => {
    const findings = decode(FindingsCodec.decode(readJSON(args.findings)), "findings");
    const diff = readFileSync(resolve(args.diff), "utf-8");
    const inlineTemplate = readFileSync(resolveInlineTemplatePath(args.template), "utf-8");
    const { comments, strays } = buildInlineComments(findings.findings, diff, {
      inlineTemplate,
      findings,
    });
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

const checkCostCmd = defineCommand({
  meta: {
    name: "check-cost",
    description:
      "Sum real USD spend from a live/finished Claude Code transcript tree (main session + subagents) against a price map — the correct cost when no clean result envelope exists (issue #36) and the outlook the review agent tracks in flight (issue #38)",
  },
  args: {
    transcript: {
      type: "positional",
      description: "Path to the session transcript JSONL (the hook's transcript_path)",
      required: true,
    },
    prices: {
      type: "string",
      description:
        "Path to price map JSON (default: bundled schema/prices.example.json — token totals stay real, cost reads as $0)",
    },
  },
  run: async ({ args }) => {
    const tree = readTranscriptTree(resolve(args.transcript));
    if (tree.missing) {
      process.stderr.write(
        `code-review check-cost: transcript ${args.transcript} is unreadable — reporting zero spend (issue #36)\n`,
      );
    }
    const usage = sumTranscriptUsage(tree.entries);
    const priceResolution = resolvePrices(args.prices);
    const prices = decode(PriceMapCodec.decode(readJSON(priceResolution.path)), "prices");
    const report = computeCost(usage.models, prices);
    process.stdout.write(
      `${JSON.stringify(
        {
          ...report,
          turns: usage.turns,
          durationMs: usage.durationMs,
          transcripts: tree.files,
          pricesProvided: priceResolution.kind === "provided",
        },
        null,
        2,
      )}\n`,
    );
  },
});

/** Read + decode a price map, degrading to null (cost axis disabled) on any failure — the budget
 *  hook fires on every tool call, so it must never process-exit the way the strict `readJSON` does. */
const tryReadPrices = (path: string): PriceMap | null => {
  try {
    const decoded = PriceMapCodec.decode(JSON.parse(readFileSync(resolve(path), "utf-8")));
    return decoded._tag === "Right" ? decoded.right : null;
  } catch {
    return null;
  }
};

/** A non-negative, finite dollar amount, or null (absent/unparseable). `0` is kept, not nulled: as a
 *  budget it disables the cost axis (decideBudget requires budgetUsd > 0); as a reserve floor it means
 *  no flat floor. */
const parseBudgetUsd = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** A file's mtime in epoch ms, or null when it does not exist (or cannot be statted). */
const mtimeMsOf = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

/** The `transcript_path` a hook payload carries, when present. */
const transcriptPathOf = (input: unknown): string | undefined => {
  const tp = (
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  )["transcript_path"];
  return typeof tp === "string" ? tp : undefined;
};

const budgetHookCmd = defineCommand({
  meta: {
    name: "budget-hook",
    description:
      "Self-dispatching Claude Code hook for budget discipline (issue #38): on PostToolBatch, steer the agent to converge once spend or wall-clock enters its soft wind-down reserve; on PreToolUse, inside the hard reserve, deny the budget-burning tools (subagent spawns, arbitrary shell, web) while leaving the draft-delivery path open. At every phase, the main agent's subagent spawns are denied until it has written its own first-pass draft (seed-draft's sidecar marker tells the seed apart), and permitted spawns are rewritten to run in the background so no batch join can block the spawner (issue #73). Reads the hook payload on stdin, measures spend from its transcript, and decides on $ and/or time. Degrades to a no-op on any error.",
  },
  args: {
    draft: {
      type: "string",
      description:
        "Path to the findings draft that is the sole permitted write target under forced convergence",
      required: true,
    },
    "budget-usd": {
      type: "string",
      description:
        "Dollar budget for the run; the cost axis is measured against it (needs --prices)",
    },
    wall: {
      type: "string",
      description: "Wall-clock budget (e.g. 20m, 1200s, 2h); the time axis is measured against it",
    },
    prices: {
      type: "string",
      description:
        "Price map JSON to recompute real spend from the transcript (omit to disable the cost axis)",
    },
    "reserve-frac": {
      type: "string",
      description:
        "Base wind-down headroom as a fraction of each budget: converge once less than this remains (default: 0.15; the soft steer tier reserves 2× this)",
    },
    "reserve-growth": {
      type: "string",
      description:
        "How much the reserve grows as a budget is spent — added at full usage, so convergence lands earlier the longer the run has gone (default: 0.25; 0 = flat reserve)",
    },
    "reserve-usd": {
      type: "string",
      description:
        "Flat dollar wind-down floor, whichever is larger with --reserve-frac (default: 0.02)",
    },
    "reserve-wall": {
      type: "string",
      description:
        "Flat wall-clock wind-down floor (e.g. 2m, 120s), whichever is larger with --reserve-frac (default: 2m)",
    },
  },
  run: async ({ args }) => {
    try {
      const draftPath = resolve(args.draft);
      const input = readStdinJSON();
      const transcriptPath = transcriptPathOf(input);
      const tree = transcriptPath ? readTranscriptTree(resolve(transcriptPath)) : undefined;
      const usage = tree ? sumTranscriptUsage(tree.entries) : undefined;
      const prices = args.prices ? tryReadPrices(args.prices) : null;
      const spentUsd =
        prices !== null && usage ? computeCost(usage.models, prices).totalCostUSD : null;
      // The absolute anchor (set by the review job, inherited by every hook incl. fan-out subagents)
      // is the true remaining wall; the per-transcript first timestamp is only the fallback — it
      // reads ≈0 in a fresh subagent and leaves the fan-out unsteered (issue #45).
      const wallMs = args.wall ? parseWallMs(args.wall) : null;
      const output = evaluateBudgetHook(input, {
        spentUsd,
        budgetUsd: parseBudgetUsd(args["budget-usd"]),
        elapsedMs: anchoredElapsedMs({
          deadlineMs: parseEpochSecMs(process.env[DEADLINE_ENV]),
          wallMs,
          firstTsMs: usage?.firstTsMs ?? null,
          nowMs: Date.now(),
        }),
        wallMs,
        reserve: {
          frac: parseFraction(args["reserve-frac"], DEFAULT_RESERVE.frac),
          growth: parseFraction(args["reserve-growth"], DEFAULT_RESERVE.growth),
          flatUsd: parseBudgetUsd(args["reserve-usd"]) ?? DEFAULT_RESERVE.flatUsd,
          flatMs: args["reserve-wall"]
            ? (parseWallMs(args["reserve-wall"]) ?? DEFAULT_RESERVE.flatMs)
            : DEFAULT_RESERVE.flatMs,
        },
        draftPath,
        mainDraftWritten: mainHasWrittenDraft(
          mtimeMsOf(draftPath),
          mtimeMsOf(seedMarkerPath(draftPath)),
        ),
      });
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (err) {
      process.stderr.write(
        `code-review budget-hook: degrading to no-op — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.stdout.write("{}\n");
    }
  },
});

const printSettingsCmd = defineCommand({
  meta: {
    name: "print-settings",
    description:
      "Emit ONE Claude Code --settings JSON composing the review agent's discipline (issue #38): the Stop deliverable gate plus the budget hooks (PreToolUse forced convergence + PostToolBatch steer) wired from one self-dispatching command. The review job generates this once and passes it as --settings.",
  },
  args: {
    draft: {
      type: "string",
      description:
        "Path to the findings draft the agent must produce — the Stop gate's target and the only write allowed under forced convergence",
      required: true,
    },
    kind: {
      type: "string",
      description: "Schema kind for the Stop gate: findings | triage | prices (default: findings)",
    },
    schema: {
      type: "string",
      description: "Path to a schema file for the Stop gate (wins over --kind)",
    },
    "schema-version": {
      type: "string",
      description: "Schema major.minor for the Stop gate (default: the draft's declared version)",
    },
    "max-nudges": {
      type: "string",
      description: "Stop-gate nudge budget before relenting (default: 5)",
    },
    counter: {
      type: "string",
      description: "Path for the Stop-gate nudge counter (default: <draft>.nudges)",
    },
    "budget-usd": {
      type: "string",
      description: "Dollar budget the cost axis is measured against (needs --prices)",
    },
    wall: {
      type: "string",
      description: "Wall-clock budget the time axis is measured against (e.g. 20m, 1200s)",
    },
    prices: {
      type: "string",
      description: "Price map JSON to recompute real spend from the transcript",
    },
    "reserve-frac": {
      type: "string",
      description:
        "Base wind-down headroom as a fraction of each budget (default: 0.15; soft tier is 2×)",
    },
    "reserve-growth": {
      type: "string",
      description:
        "How much the reserve grows as a budget is spent, converging earlier the longer the run has gone (default: 0.25; 0 = flat)",
    },
    "reserve-usd": {
      type: "string",
      description:
        "Flat dollar wind-down floor, whichever is larger with --reserve-frac (default: 0.02)",
    },
    "reserve-wall": {
      type: "string",
      description:
        "Flat wall-clock wind-down floor (e.g. 2m), whichever is larger with --reserve-frac (default: 2m)",
    },
  },
  run: async ({ args }) => {
    if (args.kind && !["findings", "triage", "prices"].includes(args.kind))
      fail(`--kind must be one of findings|triage|prices (got '${args.kind}')`);
    const settings = composeReviewSettings({
      draftPath: resolve(args.draft),
      stop: {
        kind: args.kind,
        schema: args.schema,
        schemaVersion: args["schema-version"],
        maxNudges: args["max-nudges"],
        counter: args.counter,
      },
      budget: {
        budgetUsd: args["budget-usd"],
        wall: args.wall,
        prices: args.prices,
        reserveFrac: args["reserve-frac"],
        reserveGrowth: args["reserve-growth"],
        reserveUsd: args["reserve-usd"],
        reserveWall: args["reserve-wall"],
      },
    });
    process.stdout.write(`${JSON.stringify(settings)}\n`);
  },
});

const deadlineCmd = defineCommand({
  meta: {
    name: "deadline",
    description:
      "Print the run's absolute deadline as Unix epoch seconds (now + --wall). The review job exports this as CODE_REVIEW_DEADLINE_EPOCH right before `claude -p` so every budget hook — the main agent's and each fan-out subagent's — measures the SAME true remaining wall instead of its own transcript's start, which reads ≈0 in a fresh subagent and leaves the fan-out unsteered (issue #45).",
  },
  args: {
    wall: {
      type: "string",
      description:
        "Wall-clock budget for the run (e.g. 24m, 1200s, 2h) — the deadline is now + this",
      required: true,
    },
  },
  run: async ({ args }) => {
    const wallMs = parseWallMs(args.wall);
    if (wallMs === null) {
      fail(`--wall must be a duration like 24m, 1200s, or 2h (got '${args.wall}')`);
    } else {
      process.stdout.write(`${String(deadlineEpochSec(wallMs, Date.now()))}\n`);
    }
  },
});

/** The version to derive when neither --schema nor --schema-version is given: findings carries its
 *  version in-data; triage/prices have no in-data signal (see registry.ts), so undefined selects the
 *  registry default (latest) for the kind. */
const derivedSchemaVersion = (kind: SchemaKind, raw: unknown): string | undefined =>
  kind === "findings" ? declaredVersion(raw) : undefined;

/** A bundled schema rendered for a CLI/agent to read: pretty-printed with the top-level `$schema`
 *  draft declaration stripped. `claude -p --json-schema` silently disables enforcement when a schema
 *  carries `$schema`, and the field DESCRIPTIONS are the authoritative spec the agent must follow, so
 *  this is the form both `print-schema` and `validate --explain` emit. */
const printableSchema = (schemaPath: string): string => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as Record<string, unknown>;
  const enforcementSchema = Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "$schema"),
  );
  return JSON.stringify(enforcementSchema, null, 2);
};

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
    explain: {
      type: "boolean",
      description:
        "On failure, also print the schema after the errors — its field descriptions are the authoritative spec, so the document can be fixed in one pass instead of by trial and error",
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
      if (args.explain) {
        process.stderr.write(
          `\nThe ${kind} document must conform to this schema (the field descriptions are the authoritative spec — match the property names exactly):\n${printableSchema(schemaPath)}\n`,
        );
      }
      process.exit(1);
    }
  },
});

const seedDraftCmd = defineCommand({
  meta: {
    name: "seed-draft",
    description:
      "Write a valid findings $DRAFT before the review runs: the decoded findings from a prior review when one exists and still validates (incremental re-review), else an empty-but-valid scaffold — so a valid draft exists from turn 0 (issues #52, #53). Also drops a sidecar marker beside the seed so the budget hook can tell the untouched seed from a draft the agent wrote itself (issue #73). Prints the mode chosen (prior|empty|none — none when even the scaffold write failed) to stdout; always exits 0",
  },
  args: {
    prior: {
      type: "string",
      description:
        "Path to the prior-review JSON gather staged ({ id, body }, or the literal null); its embedded base64 findings marker is decoded and becomes the seed when it validates against the schema",
    },
    out: {
      type: "string",
      description: "Path to write the seed $DRAFT to (an absolute path outside the worktree)",
      required: true,
    },
    kind: {
      type: "string",
      description: "Schema kind to validate the prior findings against (default: findings)",
    },
    schema: {
      type: "string",
      description: "Path to a schema file (wins over --kind/--schema-version)",
    },
    "schema-version": {
      type: "string",
      description:
        "Schema major.minor to validate the prior findings against (default: the kind's latest — an older-shaped prior review then falls back to the empty scaffold)",
    },
  },
  run: async ({ args }) => {
    const outPath = resolve(args.out);
    const kindArg = args.kind || "findings";
    const kind: SchemaKind = isSchemaKind(kindArg) ? kindArg : "findings";
    if (kind !== kindArg) {
      process.stderr.write(
        `Warning: unknown --kind "${kindArg}" — validating against "findings"\n`,
      );
    }

    // seed-draft is best-effort and must NEVER fail the review step (the workflow runs it under
    // `set -e`), so every path below either seeds from the prior review or degrades to the
    // empty-but-valid scaffold — none uses the process-exiting require* helpers. The only outcome
    // that skips seeding is a scaffold write that itself throws (e.g. a bad --out directory), which
    // is warned and still exits 0: the agent then writes $DRAFT itself, exactly as before seeding.

    // The sidecar marker, written right AFTER the seed so its mtime bounds the seed's: the budget
    // hook treats the draft as agent-written only once its mtime passes the marker's. Only the
    // marker's mtime is ever consumed (budget.ts mainHasWrittenDraft never reads its content), so a
    // one-line sentinel suffices. Best-effort like the seed itself — without the marker the fan-out
    // gate just accepts any existing draft.
    const writeSeedMarker = (): void => {
      try {
        writeFileSync(seedMarkerPath(outPath), "code-review seed marker\n");
      } catch (err) {
        process.stderr.write(
          `Warning: could not write the seed marker beside ${outPath} (${err instanceof Error ? err.message : String(err)}) — the seeded draft will count as agent-written\n`,
        );
      }
    };

    const writeEmptyScaffold = (): void => {
      try {
        writeFileSync(outPath, `${JSON.stringify(noticeFindings(""), null, 2)}\n`);
        writeSeedMarker();
        process.stderr.write(
          `Seeded ${outPath} with an empty valid scaffold — no decodable prior findings to build on\n`,
        );
        process.stdout.write("empty\n");
      } catch (err) {
        // The scaffold write itself failed — report "none" (not "empty"), so the workflow doesn't
        // tell the agent a scaffold exists that isn't there; the agent writes $DRAFT itself.
        process.stderr.write(
          `Warning: could not write the seed scaffold to ${outPath} (${err instanceof Error ? err.message : String(err)}) — the agent will create $DRAFT itself\n`,
        );
        process.stdout.write("none\n");
      }
    };

    // Decode the prior review's embedded findings, tolerating a missing/absent/"null"/malformed
    // file. Validated against the current schema below so an older-shaped or corrupt prior review
    // degrades to the empty scaffold rather than seeding an invalid $DRAFT.
    const priorFindings = ((): unknown => {
      if (!args.prior) return null;
      const raw = ((): unknown => {
        try {
          return JSON.parse(readFileSync(resolve(args.prior), "utf-8")) as unknown;
        } catch {
          return null;
        }
      })();
      const body =
        typeof raw === "object" && raw !== null && "body" in raw && typeof raw.body === "string"
          ? raw.body
          : null;
      return body === null ? null : parseFindingsMarker(body);
    })();

    if (priorFindings === null) {
      writeEmptyScaffold();
      return;
    }

    // Resolve + validate WITHOUT the process-exiting require* helpers: any failure (bad
    // --schema-version, unreadable schema, non-matching shape, unwritable $DRAFT) degrades to the
    // scaffold so the always-exit-0 contract holds.
    const seededFromPrior = ((): boolean => {
      try {
        const schemaPath = args.schema
          ? resolve(args.schema)
          : schemaPathFor(kind, args["schema-version"]);
        if (!validateAgainstSchema(priorFindings, schemaPath).valid) return false;
        writeFileSync(outPath, `${JSON.stringify(priorFindings, null, 2)}\n`);
        writeSeedMarker();
        return true;
      } catch (err) {
        process.stderr.write(
          `Warning: could not seed from the prior review (${err instanceof Error ? err.message : String(err)}) — falling back to the empty scaffold\n`,
        );
        return false;
      }
    })();

    if (seededFromPrior) {
      const priorList = (priorFindings as { readonly findings?: unknown }).findings;
      const count = Array.isArray(priorList) ? priorList.length : 0;
      process.stderr.write(
        `Seeded ${outPath} from the prior review (${String(count)} finding(s)) — verify each still holds against the current diff and refine in place\n`,
      );
      process.stdout.write("prior\n");
    } else {
      writeEmptyScaffold();
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
    transcript: {
      type: "string",
      description:
        "Path to the session transcript (the main .jsonl). Its tree (main + subagents) is the source of the true wall + turn count — the native envelope only sees the main agent and under-reports a fan-out (issue #59) — and refills per-model usage too when the native has none (a wall-clock kill leaves it empty, so cost is real not $0.00 — issues #39/#36)",
    },
  },
  run: async ({ args }) => {
    const envelope = unwrapAdapt(
      adapt(requireAdapterName(args.adapter), readJSONOrAbsent(args.native), args["agent-file"], {
        route: args.route,
        effort: args.effort,
        ...(args.transcript
          ? {
              transcriptFallback: (): TranscriptTelemetry =>
                transcriptFallbackFrom(args.transcript),
            }
          : {}),
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

/** Validate one finding's `patch` (when present) against the real file at `<repoRoot>/<finding.path>`,
 *  aligning the finding's `start_line`/`end_line` to the patch's removed range when it anchors one, or
 *  keeping the patch as-is when it's a pure insertion with no range to anchor — either way the patch
 *  is KEPT for the renderer to project. Drop the patch (logging why to stderr) when the file can't be
 *  read or the patch doesn't apply cleanly — the finding survives without it, never writing a
 *  suggestion. A finding with no patch passes through untouched. Never throws. */
const validateFinding = (finding: Finding, repoRoot: string): Finding => {
  if (finding.patch === undefined) return finding;
  const lines = readFileLines(resolve(repoRoot, finding.path));
  if (lines === null) {
    process.stderr.write(
      `validate-patches: ${finding.path}: could not read file at "${repoRoot}" — dropping patch\n`,
    );
    return withoutPatch(finding);
  }
  const result = validatePatch(finding.patch, lines);
  switch (result.kind) {
    case "anchored":
      return { ...finding, start_line: result.startLine, end_line: result.endLine };
    case "keep":
      // Applies cleanly but has no removed range to anchor a suggestion — leave the finding's own
      // start_line/end_line as the inline anchor; the renderer projects the patch to a ```patch block.
      return finding;
    case "drop":
      process.stderr.write(
        `validate-patches: ${finding.path}:${String(finding.start_line)}: ${result.reason} — dropping patch\n`,
      );
      return withoutPatch(finding);
  }
};

const validatePatchesCmd = defineCommand({
  meta: {
    name: "validate-patches",
    description:
      "Validate each finding's patch against the real PR-head tree, aligning the finding's range and keeping the patch when it anchors, keeping it unaligned when it's a pure insertion, or dropping it when it doesn't apply (issue #10)",
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
    const validated = {
      ...findings,
      findings: findings.findings.map((f) => validateFinding(f, repoRoot)),
    };
    process.stdout.write(`${JSON.stringify(validated, null, 2)}\n`);
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
    process.stdout.write(`${printableSchema(schemaPath)}\n`);
  },
});

const MAX_NUDGES_DEFAULT = 5;

/** Drain the Stop-hook payload delivered on stdin so the caller never sees EPIPE; its content is
 *  not needed — the decision comes from the draft on disk. Skips draining on a TTY (an interactive,
 *  manual run with nothing piped in) since readFileSync(0) would otherwise block forever waiting
 *  for EOF that never comes; absent/empty piped stdin otherwise is fine.
 *  DEFERRED (known low-risk edge): a pipe held open without data + EOF could still block here, but
 *  the real Stop hook writes its payload then closes (EOF), and the TTY case is guarded above, so
 *  the held-open-forever case isn't the production path. Revisit only if hangs are observed. */
const drainStdin = (): void => {
  if (process.stdin.isTTY) return;
  try {
    readFileSync(0);
  } catch {
    // no stdin
  }
};

/** Parse `--max-nudges`: a strict positive integer (`>= 1`). A loose `Number.parseInt` accepts
 *  `"5abc"`/`"0x5"` and `0 >= 0` allows on the first call — both silently DISABLE the gate. Reject
 *  anything not matching `^\d+$`, and reject `< 1`, loudly: a gate that never blocks must be an
 *  explicit choice (omit the hook), never a typo. */
const requireMaxNudges = (raw: string | undefined): number => {
  if (raw === undefined) return MAX_NUDGES_DEFAULT;
  if (!/^\d+$/.test(raw)) {
    fail(`--max-nudges must be a non-negative integer; got "${raw}"`);
  }
  const n = Number.parseInt(raw, 10);
  if (n < 1) {
    fail(`--max-nudges must be >= 1 — a gate that never blocks must be omitted, not set to ${raw}`);
  }
  return n;
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
      description: `Times to block before relenting so the step fails downstream as before (default: ${String(MAX_NUDGES_DEFAULT)})`,
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
        schema: args.schema,
        schemaVersion: args["schema-version"],
        maxNudges: args["max-nudges"],
        counter: args.counter,
      });
      process.stdout.write(`${JSON.stringify(stopHookSettings(command))}\n`);
      return;
    }

    drainStdin();

    const kind = requireSchemaKind(args.kind || "findings");
    const maxNudges = requireMaxNudges(args["max-nudges"]);
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
    const decision = decideGate(state, nudges, maxNudges, draftPath, kind);
    if (decision.kind === "block") {
      // CRITICAL ordering: bump the counter FIRST, and emit the block ONLY after the increment is
      // durably persisted. If the write fails, do NOT block — a block we can't bound loops forever
      // (the counter never advances → `nudges >= maxNudges` is never reached). Allow the stop and
      // log: a missed nudge is far less bad than an unbounded block loop.
      try {
        bumpNudges(counterPath, nudges);
      } catch (err) {
        process.stderr.write(
          `stop-gate: cannot persist nudge counter at ${counterPath} → allowing to avoid an unbounded block loop: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return;
      }
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
      description: "Path to inline comment Eta template (default: bundled templates/inline.eta)",
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
    const priceResolution = resolvePrices(args.prices);
    await post({
      repo: args.repo,
      headSha: args["head-sha"],
      botLogin: args["bot-login"] || "github-actions[bot]",
      findingsPath: args.findings,
      envelopePath: args.usage,
      pricesPath: priceResolution.path,
      pricesProvided: priceResolution.kind === "provided",
      templatePath: resolveTemplatePath(args.template),
      inlineTemplatePath: resolveInlineTemplatePath(args["inline-template"]),
      route: args.route,
      headBranch: args["head-branch"],
      effort: args.effort,
      testReportPath: args["test-report"],
      runUrl: args["run-url"],
      jsonUrl: args["json-url"],
      postedAt: formatUtc(new Date()),
    });
  },
});

export const main = defineCommand({
  meta: {
    name: "code-review",
    version: packageVersion,
    description:
      "Deterministic commenter for agentic PR review — gather, render, inline, post, adapt, extract, validate-patches, cost, check-cost, validate, seed-draft, stop-gate, budget-hook, print-settings, and deadline",
  },
  subCommands: {
    gather: gatherCmd,
    render: renderCmd,
    inline: inlineCmd,
    post: postCmd,
    cost: costCmd,
    "check-cost": checkCostCmd,
    validate: validateCmd,
    "seed-draft": seedDraftCmd,
    adapt: adaptCmd,
    extract: extractCmd,
    "validate-patches": validatePatchesCmd,
    "print-schema": printSchemaCmd,
    "stop-gate": stopGateCmd,
    "budget-hook": budgetHookCmd,
    "print-settings": printSettingsCmd,
    deadline: deadlineCmd,
  },
});

// Skip auto-invocation under the test runner — tests drive `main` directly via citty's runCommand.
if (!process.env["VITEST"]) {
  await runMain(main);
}
