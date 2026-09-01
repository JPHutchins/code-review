#!/usr/bin/env node
// CLI entry point — the citty subcommands wired in `main` at the bottom.

/* eslint-disable @typescript-eslint/require-await */
// citty requires async run() even when the body has no explicit await

import { defineCommand, runMain } from "citty";
import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Either } from "fp-ts/Either";
import { render, isConvergenceRound, isReviewVerdict } from "./render.js";
import { buildInlineComments, renderStraysSection } from "./inline.js";
import { computeCost, parseInstant } from "./cost.js";
import { readTranscriptTree, sumTranscriptUsage } from "./transcript.js";
import {
  evaluateBudgetHook,
  parseWallMs,
  parseFraction,
  parseEpochSecMs,
  anchoredElapsedMs,
  deadlineEpochSec,
  mainHasWrittenDraft,
  isSeedSentinel,
  SEED_SENTINEL,
  priorContextPath,
  priorAnswersPath,
  priorSuppressedPath,
  lastValidPath,
  isSubagentHookInput,
  DEFAULT_RESERVE,
  DEADLINE_ENV,
} from "./budget.js";
import { decodeAnsweredEntry, isAnsweredDrop, type StagedAnsweredEntry } from "./answered.js";
import { validateAgainstSchema, unsafeUnwrap } from "./validate.js";
import { formatUtc } from "./format.js";
import {
  ResultEnvelopeCodec,
  FindingsCodec,
  FindingsCodecV09,
  normalizeV09,
  PriceMapCodec,
  ScopeMetastasisCodec,
  TestSummaryCodec,
  isIncompleteFindings,
  RECOVERABLE_OPTIONAL_FIELDS,
} from "./schema.js";
import type { Triage, Finding, Findings, PriceMap } from "./schema.js";
import {
  buildConvergence,
  computeScopeMetastasis,
  SURFACE_SCHEMA_VERSION,
  isBelowVisibilityFloor,
  parseReviewedRoute,
  parseReviewedSha,
  priorTrajectory,
  priorBelowFloorNits,
  stripSurfaceFields,
  parseFindingsMarker,
} from "./surface.js";
import {
  buildNoticeEnvelope,
  buildUnknownNoticeEnvelope,
  isNoticeKind,
  parseAgentAllowlist,
  NOTICE_KINDS,
} from "./notice.js";
import { announce, loadClocDiff, post, reportIncomplete } from "./post.js";
import { type CheckIntent, checkRun } from "./checkrun.js";
import { parseCommand, renderCommandOutputs, safeHeredocDelim } from "./command.js";
import { react, isReaction, REACTIONS } from "./react.js";
import type { Reaction } from "./react.js";
import { awaitCiConclusion, renderCiOutputs } from "./ci.js";
import { gather, renderOutputs } from "./gather.js";
import { adapt, isAdapterName } from "./adapt.js";
import type { AdapterName, TranscriptTelemetry } from "./adapt.js";
import { extractStructured, describeLadderFailure, ladderFailureDiagnostics } from "./extract.js";
import type { ExtractKind, LadderOutcome } from "./extract.js";
import { schemaPathFor, declaredVersion, resolve as resolveRegistry } from "./registry.js";
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
import {
  buildSandboxConfig,
  deriveModelHost,
  isKnownModelHost,
  parseExtraEndpoints,
} from "./sandbox.js";
import { parseScope } from "./scope.js";
import { annotationSafe, asRecord, errMsg, readFileOrNull, tryParseJson } from "./util.js";

// The seed chain's shared upcast: a prior document (raw artifact, embedded marker, or a peeled
// surfaced blob re-stamped with the CURRENT draft version) resolves through the registry, and — when
// the strict entry rejects a legacy-shaped body carrying the new stamp — through the tolerant legacy
// codec, so a pre-0.10 prior always yields its 0.10 shape (code → id, or the synthesized id) instead
// of nothing. The ajv gate then validates the UPCAST value, never the raw doc: validating the raw doc
// against the 0.10 schema would reject every legacy prior and seed the sentinel-only cold re-review
// the migration exists to prevent.
const resolvedPriorValue = (doc: unknown): Findings | null => {
  const r = resolveRegistry("findings", doc);
  if (r.kind === "ok") return r.value;
  const legacy = FindingsCodecV09.decode(doc);
  return legacy._tag === "Right" ? normalizeV09(legacy.right) : null;
};

const readJSON = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf-8")) as unknown;
  } catch (err) {
    return fail(`Cannot read ${path}: ${errMsg(err)}`);
  }
};

const fail = (msg: string): never => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};

/** Tolerant `readJSON`: returns `undefined` (never exits) when the file is unreadable, empty, or not
 *  valid JSON, naming the specific cause on stderr. Used only for `adapt`'s native envelope, which a
 *  wall-clock kill can leave empty/truncated — `adapt` then degrades to no telemetry rather than
 *  crashing the review step. */
const readJSONOrAbsent = (path: string): unknown => {
  const read = ((): { readonly text: string } | { readonly error: string } => {
    try {
      return { text: readFileSync(resolve(path), "utf-8") };
    } catch (err) {
      return { error: errMsg(err) };
    }
  })();
  if ("error" in read) {
    process.stderr.write(
      `code-review: native envelope ${path} could not be read (${read.error}) — proceeding with no native telemetry\n`,
    );
    return undefined;
  }
  if (read.text.trim() === "") {
    process.stderr.write(
      `code-review: native envelope ${path} is empty — proceeding with no native telemetry\n`,
    );
    return undefined;
  }
  try {
    return JSON.parse(read.text) as unknown;
  } catch (err) {
    process.stderr.write(
      `code-review: native envelope ${path} is not valid JSON (${errMsg(err)}) — proceeding with no native telemetry\n`,
    );
    return undefined;
  }
};

// The optional sandbox config a notice names its allowlist from. A MISSING/unreadable file is the
// normal early-failure case (the jail is set up after triage), so it stays silent and is treated as
// absent. A file that is PRESENT but unparseable is the diagnostic case this feature exists for (a
// truncated or agent-tampered config), so it warns rather than vanishing. Either way ⇒ undefined, and
// the notice omits the allowlist rather than crashing the assemble step.
const readSandboxConfigForNotice = (path: string): unknown => {
  const text = readFileOrNull(resolve(path));
  if (text === null) return undefined;
  const parsed = tryParseJson(text);
  if (!parsed.ok) {
    process.stderr.write(
      `::warning::${annotationSafe(`code-review notice: ${path} is present but not valid JSON — omitting the agent allowlist from the notice`)}\n`,
    );
    return undefined;
  }
  return parsed.value;
};

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
  const parsed = tryParseJson(raw);
  return parsed.ok ? parsed.value : null;
};

const decode = <A>(either: Either<unknown, A>, label: string): A => {
  try {
    return unsafeUnwrap(either);
  } catch {
    return fail(`${label} does not match expected shape`);
  }
};

/** Unwrap an adapter's Either, surfacing its own message rather than a generic one. */
const unwrapAdapt = <A>(either: Either<string, A>): A => {
  try {
    if (either._tag === "Left") throw new Error(either.left);
    return either.right;
  } catch (err) {
    return fail(errMsg(err));
  }
};

/** Telemetry from a session transcript tree (main + subagents) for the true wall + turns the native
 *  envelope under-reports, and for per-model usage when the native envelope is empty. A
 *  missing/unreadable transcript yields empty models + a zero span, which `adapt` treats as "no
 *  transcript". */
const transcriptFallbackFrom = (path: string): TranscriptTelemetry => {
  const tree = readTranscriptTree(resolve(path));
  if (tree.missing)
    process.stderr.write(
      `code-review adapt: transcript ${path} is unreadable — no telemetry fallback\n`,
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

const resolveTemplatePath = (templateArg: string | undefined): string =>
  templateArg ? resolve(templateArg) : bundledPath("templates", "comment.eta");

const resolveInlineTemplatePath = (templateArg: string | undefined): string =>
  templateArg ? resolve(templateArg) : bundledPath("templates", "inline.eta");

// `provided` = a real caller map; `absent` = the bundled all-zero example. The render layer is told
// which, so an absent map reports cost as N/A, never a false $0.00.
type PriceResolution =
  | { readonly kind: "provided"; readonly path: string }
  | { readonly kind: "absent"; readonly path: string };

const resolvePrices = (pricesArg: string | undefined): PriceResolution => {
  if (pricesArg) return { kind: "provided", path: resolve(pricesArg) };
  process.stderr.write(
    "code-review: no --prices given — cost will be reported as N/A (no price map to recompute from)\n",
  );
  return { kind: "absent", path: bundledPath("schema", "prices.example.json") };
};

const TEST_REPORT_DESCRIPTION =
  'Path to a JSON test summary: {"passed": number, "failed": number, "total": number, "failures"?: [{"name": string, "message"?: string}]}';

const CLOC_DIFF_DESCRIPTION =
  "Path to a raw `cloc --git --diff <base> <head>` table, rendered verbatim in the sticky's cloc collapsible. Best-effort: an absent, unreadable, or empty file omits the collapsible.";

const CONVERGENCE_THRESHOLD_DESCRIPTION =
  "Advisory convergence tolerance: the per-finding convergence score (each finding's severity floor + confidence-and-likelihood-weighted headroom; ceilings critical 4 · major 2 · minor 1 · nit 0) at or below which the sticky reads as converged. The floor values and the systemic-likelihood rule are documented in the README and the findings schema (default: 1)";

const NIT_VISIBILITY_FLOOR_DESCRIPTION =
  "Nit visibility floor: nits whose confidence × likelihood falls below this are hidden from humans (no inline comment; a collapsed aside in the sticky) but kept in the machine blob as adjudicated. In [0, 1] (default: 0.25)";

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
    "cloc-diff": {
      type: "string",
      description: CLOC_DIFF_DESCRIPTION,
    },
    "convergence-threshold": {
      type: "string",
      description: CONVERGENCE_THRESHOLD_DESCRIPTION,
    },
    "nit-visibility-floor": {
      type: "string",
      description: NIT_VISIBILITY_FLOOR_DESCRIPTION,
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
    const clocDiff = args["cloc-diff"] ? loadClocDiff(args["cloc-diff"]) : undefined;
    // The render command renders ONE run with no PR history, so render's fallback (which requires a
    // completed round in the history) would show no convergence at all. A completed full-review run
    // IS round 1 of its conversation: pass its own counts as the history — the badge, the
    // trajectory, and the blob's stop signal all agree on it, and the shared predicates make this
    // the same decision post makes (issue #141 reviews r2 + r4).
    const route = args.route || envelope.route || null;
    const isRound =
      isConvergenceRound(route, envelope.incomplete === true || isIncompleteFindings(findings)) &&
      isReviewVerdict(findings.verdict);
    const threshold = parseConvergenceThreshold(args["convergence-threshold"]);
    // The render command previews ONE run with no PR history. A completed full-review run IS round 1 of
    // its conversation, so stamp its convergence (issue #174): the badge, the numeric trajectory, and the
    // blob all read the same stored score, the same decision post makes (issue #141 reviews r2 + r4).
    // Mirror post's stamp: convergence is pipeline-owned and always overwritten, so a draft's echoed
    // value never rides the preview blob — a round previews a fresh round-1 stamp, a non-round none.
    const stampedFindings = {
      ...findings,
      convergence: isRound ? buildConvergence(findings, threshold) : undefined,
    };
    // The `render` command previews the sticky CHROME (verdict, counts, convergence, cost) — it has no
    // diff, so it never places findings inline vs stray and shows no per-finding detail. It therefore
    // validates --nit-visibility-floor (issue #164) but does NOT apply the visible split or the
    // suppression aside: rendering shelved nits while the visible findings have no detail line would
    // invert the feature. The human/visible split is post's job — it has the diff and the prior sticky.
    const output = render({
      findings: stampedFindings,
      envelope,
      prices,
      pricesProvided: priceResolution.kind === "provided",
      template,
      reviewedSha: args["reviewed-sha"],
      route: args.route,
      effort: args.effort,
      testReport,
      clocDiff,
      convergenceThreshold: threshold,
      nitVisibilityFloor: parseNitVisibilityFloor(args["nit-visibility-floor"]),
      convergenceRound: isRound,
      postedAt: formatUtc(new Date()),
      pricedAt: new Date(),
    });
    process.stdout.write(output);
    // The standalone render command names no findings artifact (there is no --json-url flag), so
    // its output carries no machine channel — the same ::error:: post emits, because a preview that
    // looks like a review is worse than one that says what it lacks (issue #233 r2).
    process.stderr.write(
      "::error::no --json-url was supplied, so this comment names no findings artifact — the review's prose is intact but its machine channel is gone, and the next round cannot seed from it\n",
    );
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
    "nit-visibility-floor": {
      type: "string",
      description: NIT_VISIBILITY_FLOOR_DESCRIPTION,
    },
  },
  run: async ({ args }) => {
    const findings = decode(FindingsCodec.decode(readJSON(args.findings)), "findings");
    const diff = readFileSync(resolve(args.diff), "utf-8");
    const inlineTemplate = readFileSync(resolveInlineTemplatePath(args.template), "utf-8");
    // Apply the FIXED-floor part of the nit-visibility split (issue #164): a below-floor nit gets no
    // inline comment. This standalone payload builder has no prior sticky, so no one-round stickiness
    // (post applies that); it also has no sticky to carry the collapsed aside, so a suppressed nit is
    // simply absent here — the aside is post's surface.
    const floor = parseNitVisibilityFloor(args["nit-visibility-floor"]);
    const visibleFindings = findings.findings.filter((f) => !isBelowVisibilityFloor(f, floor));
    const { comments, strays } = buildInlineComments(visibleFindings, diff, {
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
    // Price a saved envelope at the RUN's own instant (issue #170), so re-running `cost` later prices
    // the same envelope to the same slot deterministically — not at whatever wall clock it is re-run at.
    const report = computeCost(
      envelope.models,
      prices,
      parseInstant(envelope.generated_at) ?? new Date(),
    );
    process.stdout.write(JSON.stringify(report, null, 2));
  },
});

const checkCostCmd = defineCommand({
  meta: {
    name: "check-cost",
    description:
      "Sum real USD spend from a Claude Code transcript tree (main + subagents) against a price map",
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
        `code-review check-cost: transcript ${args.transcript} is unreadable — reporting zero spend\n`,
      );
    }
    const usage = sumTranscriptUsage(tree.entries);
    const priceResolution = resolvePrices(args.prices);
    const prices = decode(PriceMapCodec.decode(readJSON(priceResolution.path)), "prices");
    // Price at the transcript's last activity instant (deterministic — re-running `check-cost` on the
    // same transcript prices the same slot), not the invocation wall clock (issue #170 review r2).
    const report = computeCost(
      usage.models,
      prices,
      usage.lastTsMs !== null ? new Date(usage.lastTsMs) : new Date(),
    );
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

/** Parse `--convergence-threshold`: a non-negative decimal, or undefined when absent/blank (the render
 *  layer then applies DEFAULT_CONVERGENCE_THRESHOLD as the SSOT default). An unset optional workflow
 *  input expands to "" — treat empty/whitespace as absent so the step falls back to the default rather
 *  than hard-failing under `set -euo pipefail`. Match the whole string before parsing — `parseFloat`
 *  alone silently accepts a numeric prefix (`"1,5"`→1, `"0x10"`→0) — and reject a non-finite result
 *  (a 309+-digit string parses to Infinity, which would make `score <= threshold` always true, a false
 *  "converged"); a malformed value must fail loudly, the same class the prefix guard covers. */
const parseConvergenceThreshold = (raw: string | undefined): number | undefined => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    fail(`--convergence-threshold must be a non-negative number; got "${trimmed}"`);
  }
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n)) {
    fail(`--convergence-threshold is too large to be a meaningful tolerance; got "${trimmed}"`);
  }
  return n;
};

/** Parse `--nit-visibility-floor`: a decimal in [0, 1], or undefined when absent/blank (the render/post
 *  layer then applies DEFAULT_NIT_VISIBILITY_FLOOR as the SSOT default). Same empty-string-is-absent
 *  handling as --convergence-threshold (an unset optional workflow input expands to ""). Bounded to
 *  [0, 1] because the value it gates — confidence × likelihood — is itself in [0, 1]: a value above 1
 *  would silently hide EVERY nit (a fat-fingered "25" meant as "0.25"), so it fails loudly instead. */
const parseNitVisibilityFloor = (raw: string | undefined): number | undefined => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    fail(`--nit-visibility-floor must be a number in [0, 1]; got "${trimmed}"`);
  }
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    fail(
      `--nit-visibility-floor must be in [0, 1] (it gates confidence × likelihood); got "${trimmed}"`,
    );
  }
  return n;
};

/** seed-draft's best-effort floor parse: like parseNitVisibilityFloor but NEVER exits — seed-draft's
 *  always-exit-0 contract forbids the process-exiting `fail` (it runs under the review job's `set -e`).
 *  An absent/blank/malformed/out-of-range value degrades to undefined (priorBelowFloorNits then applies
 *  the SSOT default); a genuine misconfiguration is still caught loudly at post, where the floor is
 *  actually enforced. */
const parseNitVisibilityFloorLenient = (raw: string | undefined): number | undefined => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "" || !/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
};

/** The `transcript_path` a hook payload carries, when present. */
const transcriptPathOf = (input: unknown): string | undefined => {
  const tp = (
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  )["transcript_path"];
  return typeof tp === "string" ? tp : undefined;
};

const statMtimeMsOrNull = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

const statSizeOrNull = (path: string): number | null => {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
};

/** Snapshot the draft to its last-valid sidecar when it passes the same extraction ladder `adapt`
 *  will read it back through, so `adapt`'s fallback rung only ever sees a document it accepts.
 *  The pre-seed sentinel never validates, so the untouched seed can never be checkpointed here.
 *  Best-effort — a snapshot miss never perturbs the hook's stdout decision. */
export const snapshotIfValid = (draftPath: string): void => {
  try {
    // Skip the ladder when the draft is not newer than the snapshot already taken: the hook fires
    // on every main-agent PostToolBatch, and re-validating an unchanged draft each batch is the
    // same per-event I/O class the lazy-thunk change elsewhere eliminated.
    const snapPath = lastValidPath(draftPath);
    const draftMtime = statMtimeMsOrNull(draftPath);
    if (draftMtime === null) return;
    const snapMtime = statMtimeMsOrNull(snapPath);
    if (snapMtime !== null && draftMtime <= snapMtime) return;
    // Validate the LIVE draft only (no agentFileFallbackPath): passing the snapshot as a fallback
    // here would let a valid snapshot rescue an invalid live draft through the ladder, then copy that
    // invalid draft over the good snapshot — corrupting the last-valid state we exist to preserve.
    if (
      extractStructured({ kind: "findings", native: undefined, agentFilePath: draftPath }).kind ===
      "ok"
    )
      copyFileSync(draftPath, snapPath);
  } catch (err) {
    process.stderr.write(
      `code-review: could not snapshot the last-valid draft (${errMsg(err)}) — any prior snapshot is unchanged\n`,
    );
  }
};

const budgetHookCmd = defineCommand({
  meta: {
    name: "budget-hook",
    description:
      "Self-dispatching Claude Code budget hook: on PostToolBatch steer the agent to converge as spend/wall-clock nears the budget; on PreToolUse deny budget-burning tools under the hard reserve, gate subagent spawns until the main agent has drafted, and run permitted spawns in the background. Reads the hook payload on stdin; degrades to a no-op on error.",
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
        prices !== null && usage
          ? // Price at the transcript's last activity instant, not the wall clock (issue #170 review
            // r2). Silent warn: this budget-steering cost is recomputed on EVERY tool event, so a
            // misconfigured slot map would otherwise flood stderr; the final post's cost render warns.
            computeCost(
              usage.models,
              prices,
              usage.lastTsMs !== null ? new Date(usage.lastTsMs) : new Date(),
              () => undefined,
            ).totalCostUSD
          : null;
      // The absolute anchor (set by the review job, inherited by every hook incl. fan-out subagents)
      // is the true remaining wall; the per-transcript first timestamp is only the fallback — it
      // reads ≈0 in a fresh subagent and leaves the fan-out unsteered.
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
        // Lazy: the spawn gate is the only consumer, and the hook fires on every tool event.
        mainDraftWritten: (): boolean => mainHasWrittenDraft(readFileOrNull(draftPath)),
      });
      // Only the main agent writes the draft (single-writer), so a subagent batch never introduces a
      // new valid state to preserve — snapshot on the main agent's PostToolBatch only.
      if (asRecord(input)?.["hook_event_name"] === "PostToolBatch" && !isSubagentHookInput(input))
        snapshotIfValid(draftPath);
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (err) {
      process.stderr.write(`code-review budget-hook: degrading to no-op — ${errMsg(err)}\n`);
      process.stdout.write("{}\n");
    }
  },
});

const printSettingsCmd = defineCommand({
  meta: {
    name: "print-settings",
    description:
      "Emit one Claude Code --settings JSON composing the Stop deliverable gate and the budget hooks (PreToolUse convergence + PostToolBatch steer) from one self-dispatching command",
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
      "Print the run's absolute deadline as Unix epoch seconds (now + --wall) — exported as CODE_REVIEW_DEADLINE_EPOCH so every budget hook (main and subagents) measures the same remaining wall",
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

// A decoded prior blob the pipeline stamped (surface version 0.8.0) — its scope_metastasis was
// pipeline-stamped and is authoritative. Only 0.8.0 ever stamped the field: issue #150 added
// scope_metastasis in the same commit that bumped the surface version 0.7.0 → 0.8.0, so a 0.7.0 blob
// predates the field and any entry it carries is an echo, not a stamp; a draft blob's is likewise at
// most an agent echo. Guards non-objects.
const isSurfaceStampedDoc = (doc: unknown): boolean =>
  typeof doc === "object" &&
  doc !== null &&
  !Array.isArray(doc) &&
  (doc as Record<string, unknown>)["schema_version"] === SURFACE_SCHEMA_VERSION;

// The prior document with the agent-echoable scope_metastasis removed — a stale echo would over-report
// recurrence, so the seed re-derives it fresh below. The pipeline-stamped convergence is KEPT: it is the
// last completed round's own trajectory (correct context, not a stale echo), and the review agent's only
// view of prior state is this seed, so it must carry the convergence signal (issue #174). A no-op on a
// non-object; mirrors the stripSurfaceFields filter idiom.
const withoutScopeMetastasis = (doc: unknown): unknown =>
  typeof doc === "object" && doc !== null && !Array.isArray(doc)
    ? Object.fromEntries(Object.entries(doc).filter(([key]) => key !== "scope_metastasis"))
    : doc;

const seedDraftCmd = defineCommand({
  meta: {
    name: "seed-draft",
    description:
      "Initialize $DRAFT before the review runs: write a NON-REVIEW SENTINEL (no recovery path can validate it as a review), and deliver the decoded findings of a prior review OUT-OF-BAND to a read-only context file beside the draft when one exists and still validates (incremental re-review). Skips a prior that never completed (an error-verdict notice) or that a CI-fix mechanic pass produced — the seed chain is route-aware. Prints the mode to stdout (prior-same|prior-new when prior context was delivered, by whether the prior review examined this same commit; empty-had-prior when a prior review exists but its findings could not be loaded; empty on a first review; none when even the sentinel write failed) and always exits 0",
  },
  args: {
    prior: {
      type: "string",
      description:
        "Path to the prior-review JSON gather staged ({ id, body }, or the literal null); its embedded base64 findings marker is decoded and delivered as re-review context when it validates against the schema",
    },
    "prior-findings": {
      type: "string",
      description:
        "Path to the gather-staged prior findings document (prior_findings.json). gather resolves it — from the sticky's embedded blob, or by fetching the artifact the marker names — because gather holds the repo token and this step deliberately does not: it runs the jailed agent over untrusted PR code. Absent or null falls back to decoding an embedded blob out of --prior, which needs no token",
    },
    "prior-answers": {
      type: "string",
      description:
        "Path to the gather-staged answered-findings registry (answered.json) — the prior inline findings whose threads a human reply answered (issue #151). Delivered out-of-band to the .prior-answers sidecar beside the prior context so the next-round agent sees the already-answered state; best-effort, never fails the seed",
    },
    "nit-visibility-floor": {
      type: "string",
      description:
        "The nit visibility floor (issue #164), matched to the commenter's: the prior review's below-floor nits (confidence × likelihood below it) are re-derived from --prior and delivered to the .prior-suppressed sidecar as adjudicated context, so the next-round agent does not re-raise them as fresh nits; best-effort, never fails the seed. Empty ⇒ the default",
    },
    "head-sha": {
      type: "string",
      description:
        "Current head SHA, compared against the prior review's embedded reviewed-sha to distinguish a same-commit re-review from a new-commit one; an unknown or mismatched prior SHA is treated as a new commit",
    },
    out: {
      type: "string",
      description: "Path to write the sentinel $DRAFT to (an absolute path outside the worktree)",
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
        "Schema major.minor to validate the prior findings against (default: the kind's latest — an older-shaped prior review then delivers no context)",
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
    // `set -e`), so every path below either seeds or degrades — none uses the process-exiting
    // require* helpers. The only outcome that skips seeding is a sentinel write that itself throws
    // (e.g. a bad --out directory), which is warned and still exits 0: the agent then creates
    // $DRAFT itself, exactly as if no seeding ran.
    const writeSentinel = (): boolean => {
      try {
        writeFileSync(outPath, SEED_SENTINEL);
        process.stderr.write(
          `Seeded ${outPath} with the non-review sentinel — the agent must replace it with its review\n`,
        );
        return true;
      } catch (err) {
        process.stderr.write(
          `Warning: could not write the seed sentinel to ${outPath} (${errMsg(err)}) — the agent will create $DRAFT itself\n`,
        );
        return false;
      }
    };

    // The whole prior comment body gather staged, tolerating a missing/absent/"null"/malformed
    // file: it carries the embedded findings (delivered as context below when they still validate),
    // the reviewed-sha that distinguishes a same-commit re-review from a new-commit one, and the
    // route of the review that produced it.
    const priorBody = ((): string | null => {
      if (!args.prior) return null;
      const raw = ((): unknown => {
        try {
          return JSON.parse(readFileSync(resolve(args.prior), "utf-8")) as unknown;
        } catch {
          return null;
        }
      })();
      return typeof raw === "object" &&
        raw !== null &&
        "body" in raw &&
        typeof raw.body === "string"
        ? raw.body
        : null;
    })();
    // Resolved by GATHER, not here: the sticky names an artifact (issue #217) and fetching it needs
    // the repo token, which this step does not have and must not have — it runs the jailed agent over
    // untrusted PR code. gather stages the document; this reads it. The embedded fallback keeps a
    // pre-#217 sticky working with no staged file and no token at all.
    const stagedPrior = ((): unknown => {
      if (!args["prior-findings"]) return null;
      try {
        return JSON.parse(readFileSync(resolve(args["prior-findings"]), "utf-8")) as unknown;
      } catch {
        return null;
      }
    })();
    const parsedPrior =
      stagedPrior !== null
        ? stagedPrior
        : priorBody === null
          ? null
          : parseFindingsMarker(priorBody);
    // A legacy 0.8.0 surfaced blob had its scope_metastasis PIPELINE-stamped fresh every round, so a
    // carried entry is authoritative that round (a 0.7.0 blob predates the field, so its entry is not
    // a stamp — isSurfaceStampedDoc gates on 0.8.0 alone); the post-#156 blob is the agent's own
    // document (a draft version) and carries no pipeline stamp, so any scope_metastasis in it is the agent
    // ECHOING the entry the prior seed attached to its context — stale the moment the recurrence
    // changes. Drop that echo up front (the surface peel-back keeps a legacy blob's authoritative
    // entry) so the recurrence signal comes solely from the carried-trajectory re-derivation below,
    // never a carried copy that can outlive the streak it claims.
    const strippedPrior =
      parsedPrior === null
        ? null
        : stripSurfaceFields(
            isSurfaceStampedDoc(parsedPrior) ? parsedPrior : withoutScopeMetastasis(parsedPrior),
          );
    // The answered registry decoded ONCE, up front: the seed's pre-filter below and the sidecar
    // write at the end both consume it (issue #233 r2). null = no usable registry (the flag absent,
    // or the staged file malformed — the old contract: a malformed file warns and writes NO
    // sidecar, issue #151).
    const answeredRegistry = ((): readonly StagedAnsweredEntry[] | null => {
      if (!args["prior-answers"]) return null;
      try {
        const raw = JSON.parse(readFileSync(resolve(args["prior-answers"]), "utf-8")) as unknown;
        if (!Array.isArray(raw)) throw new Error("expected an array");
        const decoded = raw.flatMap((row) => {
          const entry = decodeAnsweredEntry(row);
          return entry === null ? [] : [entry];
        });
        // A dropped row is a gap in the answered state, not a silent no-op: the agent would read
        // "no answers" for a thread that WAS answered (issue #151 review r1).
        if (decoded.length < raw.length) {
          process.stderr.write(
            `Warning: ${String(raw.length - decoded.length)} of ${String(raw.length)} answered-registry row(s) failed to decode — the seed's answered state is incomplete\n`,
          );
        }
        return decoded;
      } catch (err) {
        process.stderr.write(
          `Warning: could not read the answered-findings registry ${args["prior-answers"]} (${errMsg(err)}) — no prior-answers sidecar\n`,
        );
        return null;
      }
    })();

    // The agent-facing scope_metastasis entry is derivable from the carried convergence trajectory —
    // the same computation post() ran when it stamped it — so the seed re-attaches it: the next-round agent
    // must see the recurrence signal. A legacy blob whose stripped doc still carries the authoritative
    // pipeline stamp keeps it. The re-attach is best-effort: if the in-force schema (a consumer-pinned
    // custom --schema predating the field) rejects the adorned doc, the un-adorned prior is seeded
    // instead — losing the recurrence entry beats losing ALL prior context.
    const priorFindings = ((): unknown => {
      if (
        strippedPrior === null ||
        typeof strippedPrior !== "object" ||
        Array.isArray(strippedPrior)
      )
        return strippedPrior;
      // The registry upcast runs FIRST (code → id, or the synthesized id), so the answered pre-filter
      // below and the scope_metastasis carry both see the 0.10 shape — a raw legacy prior's findings
      // have no `id`, and the pre-filter can only match an answered entry through one. A doc the
      // upcast rejects (a malformed carried field) falls through raw: the adorn below and the gate's
      // barePrior recovery still handle it.
      const resolved = resolvedPriorValue(strippedPrior);
      // The artifact holds the agent's PRE-FILTER draft — uploaded before post's answered-filter
      // dropped verbatim re-raises — so the seed applies the SAME drop via the SAME shared
      // predicate (isAnsweredDrop, issue #233 r2): a finding the prior round closed as answered is
      // not open, and showing it as open wastes the next round on a claim post will suppress anyway.
      const doc: Record<string, unknown> =
        resolved === null
          ? (strippedPrior as Record<string, unknown>)
          : {
              ...resolved,
              findings:
                answeredRegistry !== null && answeredRegistry.length > 0
                  ? resolved.findings.filter(
                      (f) => !answeredRegistry.some((e) => isAnsweredDrop(f, e)),
                    )
                  : resolved.findings,
            };
      // A carried entry only counts when it VALIDATES as the entry shape — for a draft blob it is
      // already dropped (only a legacy pipeline-stamped blob reaches here with one), and an explicit
      // null, an array, or a malformed object (all possible in a corrupt blob; genuine posts omit the
      // key on null) falls through to the trajectory recovery like an absent one (issues #150
      // review r3 + r4). The derivation is also gated on the prior's verdict exactly like post's
      // stamp (isRound requires a review verdict): an error-verdict prior never carries a
      // re-derived entry (issue #150 review r4).
      const carried = doc["scope_metastasis"];
      if (ScopeMetastasisCodec.decode(carried)._tag === "Right") return doc;
      if (doc["verdict"] === "error") return doc;
      const computed = computeScopeMetastasis(priorTrajectory(parsedPrior, priorBody ?? ""));
      return computed === null ? doc : { ...doc, scope_metastasis: computed };
    })();

    // Validate + write WITHOUT the process-exiting require* helpers: any failure (bad
    // --schema-version, unreadable schema, non-matching shape, unwritable $DRAFT) degrades to the
    // sentinel-only seed so the always-exit-0 contract holds. The prior findings are NEVER written
    // into $DRAFT — only the sentinel goes there; the prior travels out-of-band to
    // priorContextPath, which no recovery path reads back (issue #127).
    // The answered-findings registry (issue #151), delivered beside the prior context: the prior
    // inline findings whose threads a human reply answered, so the next-round agent knows what it
    // must not re-raise verbatim. Best-effort and independent of whether the prior findings seeded —
    // even a prior that never completed (a notice) still has answered threads. A malformed staged
    // file warns and writes nothing; the workflow references the sidecar as possibly absent.
    if (answeredRegistry !== null) {
      writeFileSync(priorAnswersPath(outPath), `${JSON.stringify(answeredRegistry, null, 2)}\n`);
      process.stderr.write(
        `Seeded ${priorAnswersPath(outPath)} with ${String(answeredRegistry.length)} answered finding(s) as context\n`,
      );
    }

    // The prior round's below-visibility-floor nits (issue #164), re-derived from the SAME prior blob
    // the commenter split on — delivered as adjudicated context so the next-round agent does not
    // re-raise them as fresh nits. Best-effort and independent of whether the prior findings seeded:
    // a first review, an old blob without likelihood, or a link/omitted blob simply yields none. The
    // floor is read from the same workflow input the commenter uses, so seed and post agree within a
    // run. Correctness does not depend on this note — the blob keeps every nit and post re-suppresses a
    // re-raised still-nit by stickiness — it only spares the agent the wasted re-mining.
    // Route-gated exactly like the prior-context seed below (parseReviewedRoute === "full review"):
    // a mechanic (CI-fix) pass writes its OWN findings blob, so deriving "prior round's below-floor
    // nits" from it would deliver a CI-fix pass's nits as adjudicated prior-round context. Only a
    // completed FULL review is a prior round. The floor is parsed LENIENTLY — seed-draft must exit 0,
    // so it cannot call the process-exiting parseNitVisibilityFloor (post enforces the floor loudly).
    if (parsedPrior !== null && parseReviewedRoute(priorBody ?? "") === "full review") {
      try {
        const belowFloor = priorBelowFloorNits(
          parsedPrior,
          parseNitVisibilityFloorLenient(args["nit-visibility-floor"]),
        );
        if (belowFloor.length > 0) {
          writeFileSync(priorSuppressedPath(outPath), `${JSON.stringify(belowFloor, null, 2)}\n`);
          process.stderr.write(
            `Seeded ${priorSuppressedPath(outPath)} with ${String(belowFloor.length)} below-floor nit(s) as adjudicated context\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `Warning: could not derive the prior below-floor nits (${errMsg(err)}) — no prior-suppressed sidecar\n`,
        );
      }
    }

    const seededFromPrior =
      priorFindings === null
        ? false
        : ((): boolean => {
            try {
              const schemaPath = args.schema
                ? resolve(args.schema)
                : schemaPathFor(kind, args["schema-version"]);
              // ALWAYS validate — no short-circuit: a natively-carried 0.8.0 entry must face the
              // in-force schema like any other doc. When that schema (or the codec) rejects the doc
              // solely because of a RECOVERABLE optional field (scope_metastasis, convergence, or
              // change_size — a consumer-pinned custom --schema predating one, an older pinned CLI in
              // the merge-to-release window, or a corrupt blob-carried entry), fall back to the
              // field-stripped doc: losing those fields beats losing ALL prior context (issue #150
              // review r2 + #174 + #182 review r2). Shares post's recovery set (SSOT) so the two
              // recovery sites can never diverge. Covers BOTH gates (ajv + codec) — and both run on
              // the UPCAST value (resolvedPriorValue), never the raw legacy doc.
              const barePrior =
                typeof priorFindings === "object" && !Array.isArray(priorFindings)
                  ? Object.fromEntries(
                      Object.entries(priorFindings as Record<string, unknown>).filter(
                        ([key]) => !RECOVERABLE_OPTIONAL_FIELDS.has(key),
                      ),
                    )
                  : priorFindings;
              const accepts = (doc: unknown): Findings | null => {
                const resolved = resolvedPriorValue(doc);
                return resolved !== null && validateAgainstSchema(resolved, schemaPath).valid
                  ? resolved
                  : null;
              };
              const seedDoc =
                accepts(priorFindings) ??
                ((): Findings | null => {
                  const bare = accepts(barePrior);
                  if (bare === null) return null;
                  process.stderr.write(
                    `Note: the in-force schema rejects a carried recoverable field (scope_metastasis/convergence/change_size) — seeding the prior without it (issue #150 review r2 / #182 review r2)\n`,
                  );
                  return bare;
                })();
              if (seedDoc === null) return false;
              // Skip a prior that never completed (verdict "error" + no findings — the notice
              // signature, isIncompleteFindings) and a prior that is not unmistakably a completed
              // FULL review (route-aware seed chain): a CI-fix mechanic pass must not sit in the
              // seed chain as if it were the previous review. The route marker is the ONLY
              // reliable signal — round history can't identify the last review (a mechanic carries
              // a full review's rounds forward), so a no-route prior is unknown and skipped: one
              // cold review is cheaper than a false prior (issue #127 round-2).
              if (isIncompleteFindings(seedDoc)) return false;
              if (parseReviewedRoute(priorBody ?? "") !== "full review") return false;
              writeFileSync(outPath, SEED_SENTINEL);
              writeFileSync(priorContextPath(outPath), `${JSON.stringify(seedDoc, null, 2)}\n`);
              process.stderr.write(
                `Seeded ${outPath} with the sentinel and wrote the prior review (${String(seedDoc.findings.length)} finding(s)) to ${priorContextPath(outPath)} as context\n`,
              );
              return true;
            } catch (err) {
              process.stderr.write(
                `Warning: could not seed from the prior review (${errMsg(err)}) — seeding the sentinel only\n`,
              );
              return false;
            }
          })();

    // prior-same/prior-new split on whether the seeded review examined this exact commit; an unknown
    // prior SHA (older comment, or the all-zeros placeholder) falls to prior-new so the agent
    // re-checks against the current diff rather than assuming the code is unchanged. When nothing
    // could be seeded, empty-had-prior still tells the agent a prior review exists (vs a true first
    // review), and none marks even the sentinel write failing.
    const mode = ((): string => {
      if (seededFromPrior) {
        const priorSha = priorBody === null ? null : parseReviewedSha(priorBody);
        return args["head-sha"] && priorSha && priorSha === args["head-sha"].toLowerCase()
          ? "prior-same"
          : "prior-new";
      }
      if (!writeSentinel()) return "none";
      return priorBody === null ? "empty" : "empty-had-prior";
    })();
    process.stdout.write(`${mode}\n`);
  },
});

const adaptCmd = defineCommand({
  meta: {
    name: "adapt",
    description: "Map a native agent-CLI result envelope onto the abstract SPEC envelope",
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
    "agent-file-fallback": {
      type: "string",
      description:
        "Path to the last-valid findings snapshot, tried after --agent-file and before the native envelope; recovers the last valid state when a wall-clock kill left --agent-file truncated, so the review posts that instead of a 'did not complete' notice",
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
        "Path to the session transcript (main .jsonl). Its tree (main + subagents) gives the true wall + turn count the native envelope under-reports, and refills per-model usage when the native envelope is empty (e.g. after a wall-clock kill)",
    },
  },
  run: async ({ args }) => {
    // The agent-file still holds the pre-seeded SENTINEL when the agent never wrote its own review
    // (content check — the same isSeedSentinel test the budget hook uses via the budget.ts SSOT, so
    // a coarse-timestamp filesystem can't misclassify a fresh draft). The sentinel never validates,
    // so it can't be recovered as a review; the flag only refines the "did not complete" message.
    // A missing draft is inert (there is no seed to recover), and a non-seeded caller sees nothing.
    // Size-gated: only a sentinel-sized file (plus a trailing-newline tolerance) can be the
    // sentinel, so a real review — the largest input read back — is never read twice per run.
    const agentFile = args["agent-file"];
    const agentFileSize = agentFile ? statSizeOrNull(agentFile) : null;
    const seedUnrevised =
      agentFileSize !== null &&
      agentFileSize <= Buffer.byteLength(SEED_SENTINEL) + 2 &&
      isSeedSentinel(readFileOrNull(agentFile));
    const envelope = unwrapAdapt(
      adapt(requireAdapterName(args.adapter), readJSONOrAbsent(args.native), agentFile, {
        route: args.route,
        effort: args.effort,
        agentFileFallbackPath: args["agent-file-fallback"],
        seedUnrevised,
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

const noticeCmd = defineCommand({
  meta: {
    name: "notice",
    description:
      "Emit an abstract envelope for a run that produced no completed review (security block, triage error, setup failure, checkout failure, or empty run) — flagged incomplete so the commenter renders it honestly and won't bury a real review",
  },
  args: {
    kind: {
      type: "positional",
      description: `One of: ${NOTICE_KINDS.join(", ")} (an unrecognized kind renders a generic incomplete notice rather than failing — the pinned CLI is older than the workflow)`,
      required: true,
    },
    reasons: {
      type: "string",
      description:
        "security-blocked / triage-error only: the triage's fail-closed reason string (empty/omitted ⇒ the no-reason wording)",
    },
    "sandbox-config": {
      type: "string",
      description:
        "no-output / triage-error only: path to the agent's sandbox-runtime settings (sandbox.json); its network.allowedDomains is named in the notice so an egress-blocked review self-diagnoses. Missing or unreadable ⇒ the allowlist is omitted (an early failure runs before the jail is set up).",
    },
  },
  // An unrecognized kind degrades to a generic incomplete notice instead of exiting non-zero: a
  // `notice <kind>` call under the workflow's `set -euo pipefail` must never crash the assemble
  // step into posting nothing, and an unknown kind almost always means version skew, not a typo.
  run: ({ args }) => {
    if (!isNoticeKind(args.kind)) {
      process.stderr.write(
        `::warning::code-review notice: unrecognized kind "${annotationSafe(args.kind)}" — the pinned CLI is older than the workflow calling it; rendering a generic incomplete notice\n`,
      );
      process.stdout.write(`${JSON.stringify(buildUnknownNoticeEnvelope(args.kind), null, 2)}\n`);
      return;
    }
    // Read the sandbox config only for the kinds that name the allowlist (a jailed agent ran), so the
    // "no-output / triage-error only" contract is enforced by the handler, not just documented.
    const namesAllowlist = args.kind === "no-output" || args.kind === "triage-error";
    const agentAllowlist =
      namesAllowlist && args["sandbox-config"]
        ? parseAgentAllowlist(readSandboxConfigForNotice(args["sandbox-config"]))
        : [];
    process.stdout.write(
      `${JSON.stringify(buildNoticeEnvelope(args.kind, args.reasons, agentAllowlist), null, 2)}\n`,
    );
  },
});

const isExtractSchemaKind = (s: string): s is ExtractKind => s === "findings" || s === "triage";

// no "prices" — unlike print-schema's kinds.
const requireExtractSchemaKind = (name: string): ExtractKind =>
  isExtractSchemaKind(name)
    ? name
    : fail(`Unknown kind "${name}" for extract — expected one of: findings, triage`);

/** Fail-closed triage synthesized when the ladder can't recover a validated triage verdict — never
 *  defaults to safe. */
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

const withoutPatch = (finding: Finding): Finding => {
  const copy = { ...finding };
  delete copy.patch;
  return copy;
};

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

/** Align/keep/drop one finding's `patch` against the real file at `<repoRoot>/<finding.path>`:
 *  aligned to the patch's removed range, kept as-is for a pure insertion, or dropped (logged) when
 *  the file can't be read or the patch doesn't apply. Never throws; a no-patch finding passes through. */
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
      "Validate each finding's patch against the real PR-head tree: align the finding's range and keep the patch when it anchors, keep it unaligned for a pure insertion, or drop it when it doesn't apply",
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

const requireAdapterName = (name: string): AdapterName =>
  isAdapterName(name) ? name : fail(`Unknown adapter "${name}" — supported: claude-code`);

const isSchemaKind = (s: string): s is SchemaKind =>
  s === "findings" || s === "triage" || s === "prices";

const requireSchemaKind = (name: string): SchemaKind =>
  isSchemaKind(name)
    ? name
    : fail(`Unknown schema "${name}" — expected one of: findings, triage, prices`);

const requireSchemaPath = (kind: SchemaKind, version: string | undefined): string => {
  try {
    return schemaPathFor(kind, version);
  } catch (err) {
    return fail(errMsg(err));
  }
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

/** Drain the Stop-hook payload on stdin so the caller never sees EPIPE; its content is unused (the
 *  decision comes from the draft on disk). Skips on a TTY, where readFileSync(0) would block forever
 *  waiting for an EOF that never comes; the real Stop hook writes then closes, so a held-open pipe
 *  isn't the production path. */
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
          `stop-gate: cannot persist nudge counter at ${counterPath} → allowing to avoid an unbounded block loop: ${errMsg(err)}\n`,
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
      "Resolve the PR from the CI head SHA and gather review inputs (diff with git-diff fallback, PR context, prior bot review, untrusted PR conversation to triage, failing-job logs) as files for the review agent",
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
    "default-branch": {
      type: "string",
      description:
        "The repo's default branch — the trusted base the review checks out, and the reference for the full (triage) diff; a PR based on any other branch is treated as stacked",
      required: true,
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
      defaultBranch: args["default-branch"],
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
    "cloc-diff": {
      type: "string",
      description: CLOC_DIFF_DESCRIPTION,
    },
    "run-url": {
      type: "string",
      description:
        "Workflow run URL (transcript/traces), rendered as a link in the LLM Disclosure aside and in the review-object body",
    },
    "json-url": {
      type: "string",
      description:
        "URL to the machine-readable findings JSON artifact, pointed at from the sticky and each inline comment",
    },
    "convergence-threshold": {
      type: "string",
      description: CONVERGENCE_THRESHOLD_DESCRIPTION,
    },
    "nit-visibility-floor": {
      type: "string",
      description: NIT_VISIBILITY_FLOOR_DESCRIPTION,
    },
    inline: {
      type: "boolean",
      description:
        "Also render findings as inline review comments on the diff. Off by default: an inline thread cannot be revised by a later round, so stale threads accumulate. The review object is posted either way; with this off the sticky lists the findings instead",
    },
    "unverified-no-logs": {
      type: "boolean",
      description:
        "Mark the review unverified: the fast-fix route ran with no failing-job logs staged, so its findings came from the diff alone. The caller decides this — the logs are staged in the review job, not here",
    },
  },
  run: async ({ args }) => {
    const priceResolution = resolvePrices(args.prices);
    await post({
      repo: args.repo,
      // The workflow's post step threads HEAD_REPO env (the fork's owner/name) — a finding
      // permalink targets the tree the reviewed SHA lives in (issue #231 r1). Absent/empty ⇒ the
      // base repo. Env rather than a flag: an older pinned CLI simply ignores it.
      headRepo: process.env["HEAD_REPO"] || undefined,
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
      clocDiffPath: args["cloc-diff"],
      runUrl: args["run-url"],
      jsonUrl: args["json-url"],
      convergenceThreshold: parseConvergenceThreshold(args["convergence-threshold"]),
      nitVisibilityFloor: parseNitVisibilityFloor(args["nit-visibility-floor"]),
      inline: args.inline,
      unverifiedNoLogs: args["unverified-no-logs"],
      postedAt: formatUtc(new Date()),
      pricedAt: new Date(),
    });
  },
});

const announceCmd = defineCommand({
  meta: {
    name: "announce",
    description:
      "Post (or update) the sticky the moment a review starts — an in-progress placeholder linking the run — so a workflow_run review, which runs from the default branch and is otherwise invisible on the PR, is visibly under way. Preserves a prior sticky's embedded findings + reviewed-sha markers so the re-review seed survives the swap.",
  },
  args: {
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
    "run-url": {
      type: "string",
      description: "Workflow run URL the placeholder links to",
      required: true,
    },
    "bot-login": {
      type: "string",
      description:
        "Bot login to trust for the sticky comment upsert (default: github-actions[bot])",
    },
    "head-branch": {
      type: "string",
      description: "Head branch to disambiguate the PR when multiple share a commit",
    },
  },
  run: async ({ args }) => {
    // Best-effort, like `react`: the in-progress sticky is cosmetic, so a transient API error must
    // warn and exit 0 rather than fail its job (the review + real comment proceed regardless).
    await announce({
      repo: args.repo,
      headSha: args["head-sha"],
      botLogin: args["bot-login"] || "github-actions[bot]",
      runUrl: args["run-url"],
      headBranch: args["head-branch"],
    }).catch((err: unknown) =>
      // `::warning::` so a persistently broken announce shows up in the run's annotations, not only
      // buried in the step log — `announce` otherwise reports success while having posted nothing.
      process.stderr.write(
        `::warning::code-review announce: could not post the in-progress sticky (${annotationSafe(errMsg(err))}) — continuing (cosmetic)\n`,
      ),
    );
  },
});

const isCheckIntent = (s: string): s is CheckIntent =>
  s === "in_progress" || s === "neutral" || s === "failure" || s === "cancelled";

const checkRunCmd = defineCommand({
  meta: {
    name: "check-run",
    description:
      "Upsert the native 'Code review' check-run on the head SHA — the attribution surface that appears in the PR's own checks list and (writing to the base repo) works for fork PRs too. `in_progress` at review start, `neutral` when the review completes, `failure` when it didn't, `cancelled` when a cancelled review settles its own check (matched by details_url, so it never touches a superseding run's check). Forward-only: `failure`/`cancelled` never overwrite a completed review.",
  },
  args: {
    repo: { type: "string", description: "Repository (owner/name)", required: true },
    "head-sha": {
      type: "string",
      description: "Head SHA the check-run is anchored to",
      required: true,
    },
    status: {
      type: "positional",
      description: "One of: in_progress, neutral, failure, cancelled",
      required: true,
    },
    "run-url": {
      type: "string",
      description:
        "Workflow run URL the check-run's details link to (also the ownership key for `cancelled`)",
      required: true,
    },
  },
  run: async ({ args }) => {
    if (!isCheckIntent(args.status)) {
      // Best-effort like `announce`: the check-run is an attribution aid, so an unknown status (version
      // skew) warns and exits 0 rather than failing the job the review otherwise proceeds through.
      process.stderr.write(
        `::warning::code-review check-run: unrecognized status "${annotationSafe(args.status)}" — expected in_progress, neutral, failure, or cancelled; skipping\n`,
      );
      return;
    }
    await checkRun({
      repo: args.repo,
      headSha: args["head-sha"],
      intent: args.status,
      runUrl: args["run-url"],
    }).catch((err: unknown) =>
      process.stderr.write(
        `::warning::code-review check-run: could not upsert the check-run (${annotationSafe(errMsg(err))}) — continuing (attribution aid)\n`,
      ),
    );
  },
});

const reportIncompleteCmd = defineCommand({
  meta: {
    name: "report-incomplete",
    description:
      "Post (or update) the sticky when a review job hard-failed and posted nothing — an attributed 'did not complete' notice linking the run, telling the reader to re-request; with --cancelled, the informational 'superseded — no action needed' notice instead (issue #139). Never buries a completed review, and never overwrites a superseding run's live in-progress placeholder.",
  },
  args: {
    repo: { type: "string", description: "Repository (owner/name)", required: true },
    "head-sha": {
      type: "string",
      description: "Trusted head SHA to resolve the PR (from workflow_run.head_sha)",
      required: true,
    },
    "run-url": {
      type: "string",
      description: "Workflow run URL the notice links to",
      required: true,
    },
    "bot-login": {
      type: "string",
      description:
        "Bot login to trust for the sticky comment upsert (default: github-actions[bot])",
    },
    "head-branch": {
      type: "string",
      description: "Head branch to disambiguate the PR when multiple share a commit",
    },
    cancelled: {
      type: "boolean",
      description:
        "This run was CANCELLED before completing (typically superseded by a newer run on the same branch) — post the informational 'superseded' notice, not the failure notice (issue #139)",
    },
  },
  run: async ({ args }) => {
    await reportIncomplete({
      repo: args.repo,
      headSha: args["head-sha"],
      botLogin: args["bot-login"] || "github-actions[bot]",
      runUrl: args["run-url"],
      headBranch: args["head-branch"],
      cancelled: args.cancelled,
    }).catch((err: unknown) =>
      process.stderr.write(
        `::warning::code-review report-incomplete: could not post the notice (${annotationSafe(errMsg(err))}) — continuing\n`,
      ),
    );
  },
});

/** Parse a `--max-duration`/ceiling flag to whole seconds; a bad value is trusted-config error, so
 *  fail loudly rather than silently disabling the clamp. undefined ⇒ no ceiling. */
const requireCeilingSec = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const ms = parseWallMs(raw);
  if (ms === null)
    return fail(`--max-duration must be a duration like 60m, 3600s, or 1h (got "${raw}")`);
  return Math.floor(ms / 1000);
};

const requireCeilingUsd = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw.replace(/^\$/, ""));
  if (!Number.isFinite(n) || n < 0) fail(`--max-usd must be a non-negative number (got "${raw}")`);
  return n;
};

const requireMaxInstructions = (raw: string | undefined): number => {
  if (raw === undefined) return 4000;
  if (!/^\d+$/.test(raw)) fail(`--max-instructions must be a non-negative integer (got "${raw}")`);
  return Number.parseInt(raw, 10);
};

const requirePositiveInt = (raw: string, flag: string): number => {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && /^\d+$/.test(raw)
    ? n
    : fail(`${flag} must be a positive integer; got "${raw}"`);
};

const requireWallMs = (raw: string | undefined, flag: string, fallback: string): number => {
  const ms = parseWallMs(raw || fallback);
  return ms === null
    ? fail(`${flag} must be a duration like 30m, 15s, or 1h (got "${raw ?? ""}")`)
    : ms;
};

const parseCommandCmd = defineCommand({
  meta: {
    name: "parse-command",
    description:
      'Resolve a PR\'s head (SHA/branch/repo) from its NUMBER via the API and parse a ChatOps trigger comment ("/code-review [24m] [$1.00] <instructions>") into $GITHUB_OUTPUT lines. The untrusted comment is parsed here in type-safe code, never in workflow bash, and the head is resolved from the trusted PR number, never from the comment text. Emits should_run=false (and nothing else) when the comment is not the trigger, the PR is closed, or resolution fails.',
  },
  args: {
    repo: { type: "string", description: "Repository (owner/name)", required: true },
    pr: {
      type: "string",
      description: "PR number (from github.event.issue.number — trusted event data)",
      required: true,
    },
    "comment-body": {
      type: "string",
      description:
        "The comment body to parse (default: the CODE_REVIEW_COMMENT_BODY env var — the safe way to pass untrusted text without shell interpolation)",
    },
    trigger: {
      type: "string",
      description: 'Trigger token the comment must begin with (default: "/code-review")',
    },
    "max-duration": {
      type: "string",
      description:
        "Ceiling the requested duration is clamped to (e.g. 60m); omit for no clamp — a comment could then request an unbounded wall, so set this",
    },
    "max-usd": {
      type: "string",
      description: "Ceiling the requested USD budget is clamped to (e.g. 5); omit for no clamp",
    },
    "max-instructions": {
      type: "string",
      description: "Max characters of free-form instructions kept (default: 4000)",
    },
  },
  run: async ({ args }) => {
    const body = args["comment-body"] || process.env["CODE_REVIEW_COMMENT_BODY"] || "";
    const result = await parseCommand({
      repo: args.repo,
      prNumber: requirePositiveInt(args.pr, "--pr"),
      body,
      options: {
        trigger: args.trigger || "/code-review",
        maxDurationSec: requireCeilingSec(args["max-duration"]),
        maxUsd: requireCeilingUsd(args["max-usd"]),
        maxInstructionsLen: requireMaxInstructions(args["max-instructions"]),
      },
    });
    if (result.kind === "skip") {
      process.stderr.write(`code-review parse-command: not running — ${result.reason}\n`);
      process.stdout.write(renderCommandOutputs(result, "UNUSED"));
      return;
    }
    for (const note of result.args.notes)
      process.stderr.write(`code-review parse-command: ${note}\n`);
    const delim = safeHeredocDelim(result.args.instructions, () => randomBytes(16).toString("hex"));
    process.stdout.write(renderCommandOutputs(result, delim));
  },
});

const requireReaction = (name: string): Reaction =>
  isReaction(name) ? name : fail(`Unknown reaction "${name}" — one of: ${REACTIONS.join(", ")}`);

const reactCmd = defineCommand({
  meta: {
    name: "react",
    description:
      "Add and/or remove a GitHub reaction on a PR/issue comment — the ChatOps acknowledgement (👀 on receipt, swapped to 🚀 on completion). Cosmetic: warns and exits 0 on any API error so a reaction never fails the job.",
  },
  args: {
    repo: { type: "string", description: "Repository (owner/name)", required: true },
    "comment-id": {
      type: "string",
      description: "Comment id to react on (github.event.comment.id)",
      required: true,
    },
    add: { type: "string", description: `Reaction to add: ${REACTIONS.join(" | ")}` },
    remove: {
      type: "string",
      description: "Reaction (of the token owner) to remove after adding — for the 👀→🚀 swap",
    },
  },
  run: async ({ args }) => {
    const commentId = requirePositiveInt(args["comment-id"], "--comment-id");
    const add = args.add ? requireReaction(args.add) : undefined;
    const remove = args.remove ? requireReaction(args.remove) : undefined;
    if (add === undefined && remove === undefined)
      fail("react: nothing to do — pass --add and/or --remove");
    await react({ repo: args.repo, commentId, add, remove }).catch((err: unknown) =>
      process.stderr.write(
        `code-review react: reaction update failed (${errMsg(err)}) — continuing (reactions are cosmetic)\n`,
      ),
    );
  },
});

const awaitCiCmd = defineCommand({
  meta: {
    name: "await-ci",
    description:
      "Wait for the PR head's CI workflow run to conclude, then emit its REAL conclusion + run id to $GITHUB_OUTPUT (ci_settled, ci_conclusion, ci_run_id). The on-demand comment trigger uses this so it routes on the same CI result the CI-completion trigger would — success → full review, failure → mechanic with that run's logs — instead of reviewing blind. Polls until the run completes or the timeout elapses; ci_settled=false ⇒ no conclusive result (caller should decline to review, not guess).",
  },
  args: {
    repo: { type: "string", description: "Repository (owner/name)", required: true },
    "head-sha": {
      type: "string",
      description: "PR head SHA to find the CI run for (resolved from the trusted PR number)",
      required: true,
    },
    "ci-workflow": {
      type: "string",
      description: 'CI workflow name to wait for — the name: of your CI workflow (default: "CI")',
    },
    timeout: {
      type: "string",
      description: "Give up waiting after this wall (default: 30m)",
    },
    "poll-interval": {
      type: "string",
      description: "How often to re-check the run status (default: 15s)",
    },
  },
  run: async ({ args }) => {
    const workflowName = args["ci-workflow"] || "CI";
    const outcome = await awaitCiConclusion(args.repo, args["head-sha"], {
      workflowName,
      pollIntervalMs: requireWallMs(args["poll-interval"], "--poll-interval", "15s"),
      timeoutMs: requireWallMs(args.timeout, "--timeout", "30m"),
    });
    process.stderr.write(
      outcome.kind === "concluded"
        ? `code-review await-ci: CI run ${String(outcome.runId)} ("${workflowName}") concluded "${outcome.conclusion}"\n`
        : `code-review await-ci: no run named "${workflowName}" concluded before the timeout — not reviewing.${
            outcome.seenNames.length > 0
              ? ` Workflow names seen for this head SHA: ${outcome.seenNames.join(", ")} — check --ci-workflow matches one.`
              : " No workflow runs were seen for this head SHA at all."
          }\n`,
    );
    process.stdout.write(renderCiOutputs(outcome));
  },
});

const checkScopeCmd = defineCommand({
  meta: {
    name: "check-scope",
    description:
      "Validate + normalize the workflow's `scope` input — the languages/inputs the project accepts (issue #139). Prints the normalized space-separated language list for splicing into the review prompt, or nothing when the scope is empty (the reviewer then infers it from the README's first paragraph). A structurally malformed value is rejected rather than spliced in as-is.",
  },
  args: {
    scope: {
      type: "string",
      description:
        'The raw scope value — whitespace/comma/semicolon-separated language names (e.g. "C C++"); empty ⇒ absent',
    },
  },
  run: ({ args }) => {
    const parsed = parseScope(args.scope);
    switch (parsed.kind) {
      case "absent":
        return;
      case "invalid":
        return fail(`check-scope: ${parsed.reason}`);
      case "ok":
        process.stdout.write(`${parsed.languages.join(" ")}\n`);
    }
  },
});

const sandboxConfigCmd = defineCommand({
  meta: {
    name: "sandbox-config",
    description:
      "Emit the sandbox-runtime (srt) settings that jail the untrusted review agent's egress: allow the model host (derived from api_base_url), the GitHub API/host, and the consumer's extra_endpoints; deny all else; filesystem isolation off",
  },
  args: {
    "api-base-url": {
      type: "string",
      description:
        "The model endpoint the CLI dials (ANTHROPIC_BASE_URL) — its host is allowlisted",
      required: true,
    },
    extra: {
      type: "string",
      description:
        "Whitespace-separated host[:port] list of extra domains to allow (the extra_endpoints input)",
    },
    out: {
      type: "string",
      description: "Write the settings JSON here instead of stdout",
    },
    "known-model-host": {
      type: "string",
      description:
        "Additional model HOST(S) to treat as known (space-separated bare hostnames, not URLs) — the consumer's declared host(s) for a provider outside the built-in set; a derived host outside the built-ins and this list warns (or fails under --strict-host)",
    },
    "strict-host": {
      type: "boolean",
      description:
        "Fail (instead of warning) when the model host derived from api_base_url is not a well-known or declared host — closes the fail-open-on-typo gap where a mistyped api_base_url would still be allowlisted and sent the key",
    },
  },
  run: ({ args }) => {
    // The jail derives its ONLY egress allowlist entry from api_base_url; a typo now fails OPEN (dials
    // whatever it names). Warn loudly on an unknown host so a misconfiguration is visible in the setup
    // log, or hard-fail under --strict-host. A consumer on a provider outside the built-in set declares
    // it via --known-model-host so it passes while a typo of it does not.
    const modelHost = deriveModelHost(args["api-base-url"]);
    // Both --known-model-host AND --extra count as declared: extra_endpoints already allowlists a
    // consumer's self-hosted model host through this same jail (and the reusable documents that use),
    // so treating it as known avoids warning on a host the admin explicitly vouched for.
    const declaredHosts = [
      ...(args["known-model-host"] ? parseExtraEndpoints(args["known-model-host"]) : []),
      ...(args.extra ? parseExtraEndpoints(args.extra) : []),
    ];
    if (!isKnownModelHost(modelHost, declaredHosts)) {
      const message = `code-review sandbox-config: derived model host "${modelHost}" is not a well-known or declared host — the jail will allow egress to it and send MODEL_API_KEY there; verify api_base_url is correct`;
      // Both paths surface as GitHub annotations (::error:: hard-fails, ::warning:: continues), so the
      // same condition is visible the same way whether or not --strict-host is set.
      if (args["strict-host"]) {
        process.stderr.write(`::error::${annotationSafe(message)}\n`);
        process.exit(1);
      }
      process.stderr.write(`::warning::${annotationSafe(message)}\n`);
    }
    const config = buildSandboxConfig({ apiBaseUrl: args["api-base-url"], extra: args.extra });
    const json = `${JSON.stringify(config, null, 2)}\n`;
    if (args.out) {
      writeFileSync(resolve(args.out), json);
    } else {
      process.stdout.write(json);
    }
  },
});

export const main = defineCommand({
  meta: {
    name: "code-review",
    version: packageVersion,
    description: "Deterministic commenter for agentic PR review",
  },
  subCommands: {
    gather: gatherCmd,
    "parse-command": parseCommandCmd,
    react: reactCmd,
    "await-ci": awaitCiCmd,
    render: renderCmd,
    inline: inlineCmd,
    post: postCmd,
    announce: announceCmd,
    "check-run": checkRunCmd,
    "check-scope": checkScopeCmd,
    "report-incomplete": reportIncompleteCmd,
    cost: costCmd,
    "check-cost": checkCostCmd,
    validate: validateCmd,
    "seed-draft": seedDraftCmd,
    adapt: adaptCmd,
    notice: noticeCmd,
    extract: extractCmd,
    "validate-patches": validatePatchesCmd,
    "print-schema": printSchemaCmd,
    "stop-gate": stopGateCmd,
    "budget-hook": budgetHookCmd,
    "print-settings": printSettingsCmd,
    deadline: deadlineCmd,
    "sandbox-config": sandboxConfigCmd,
  },
});

// Skip auto-invocation under the test runner — tests drive `main` directly via citty's runCommand.
if (!process.env["VITEST"]) {
  await runMain(main);
}
