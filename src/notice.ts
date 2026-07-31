// The notices the review workflow synthesizes when there is no completed review to post: a security
// block (triage returned a genuine unsafe verdict), a triage that could not evaluate (an operational
// failure, not a verdict about the diff), a setup failure before triage could run, a PR head that
// would not check out, or a run that passed triage but emitted nothing. Their messages and the
// "incomplete" envelope shape live here — one typed SSOT — rather than as jq object literals spread
// across the workflow YAML, so the commenter renders every one honestly (no false "clean
// review"/"$0.00", and an operational failure never reads as a security verdict about the diff) and
// the sticky precedence guard treats them as non-completing.

import { DEFAULT_SCHEMA_VERSION, noticeFindings } from "./schema.js";
import type { ResultEnvelope } from "./schema.js";

// One list is the source of truth for the kind union, its runtime guard, and the CLI's kind listing,
// so adding a kind is a single edit rather than five that can drift out of sync.
export const NOTICE_KINDS = [
  "security-blocked",
  "triage-error",
  "setup-failed",
  "checkout-failed",
  "no-output",
] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const isNoticeKind = (s: string): s is NoticeKind => NOTICE_KINDS.some((k) => k === s);

// Blockquote every line so a multi-line reason stays quoted, not just its first line.
const blockquote = (text: string): string => text.replaceAll("\n", "\n> ");

// A reason-bearing notice: when the triage supplied a detail string — a genuine unsafe verdict, or
// the operational failure it hit — quote it under the lead; otherwise fall back to the no-reason
// wording. The `typeof` guard fails closed on a null reason too (a JSON round-trip can yield null
// where the type says undefined), never crashing this render path on `.trim()`.
const reasoned = (lead: string, noReason: string, reasons: string | undefined): string =>
  typeof reasons === "string" && reasons.trim() !== ""
    ? `${lead}\n\n> ${blockquote(reasons)}`
    : noReason;

const noticeSummary = (kind: NoticeKind, reasons: string | undefined): string => {
  switch (kind) {
    case "security-blocked":
      return reasoned(
        "### 🛑 Code review skipped by the security gate\n\nThe diff was flagged as unsafe to apply and execute:",
        "### 🛑 Code review skipped by the security gate\n\nThe security triage returned an unsafe verdict without a reason. See workflow logs.",
        reasons,
      );
    case "triage-error":
      return reasoned(
        "### 🛠️ Security gate could not evaluate\n\nThe security triage could not produce a verdict (operational error), so the review failed closed — this is an infrastructure failure, not a finding about this diff. Re-run to retry a transient fault; a persistent one is a configuration issue (see the workflow logs). The triage step reported:",
        "### 🛠️ Security gate could not evaluate\n\nThe security triage could not produce a verdict (operational error), so the review failed closed — this is an infrastructure failure, not a finding about this diff. Re-run to retry a transient fault; a persistent one is a configuration issue (see the workflow logs).",
        reasons,
      );
    case "setup-failed":
      return "### 🛠️ Review did not run\n\nThe review job failed before the security triage could run (e.g. dependency install or environment setup). See the workflow logs — this is an infrastructure failure, not a security verdict.";
    case "checkout-failed":
      return "### ⚠️ Could not check out the PR head\n\nThe PR head commit could not be fetched or checked out (it may have been force-pushed away, or is otherwise unavailable), so the review was skipped rather than run against the wrong tree. See workflow logs.";
    case "no-output":
      return "### ⚠️ Review did not complete\n\nThe diff passed triage but the review produced no output. See workflow logs.";
  }
};

const noticeEnvelope = (summary: string): ResultEnvelope => ({
  schema_version: DEFAULT_SCHEMA_VERSION,
  findings: noticeFindings(summary),
  models: [],
  turns: 0,
  duration_ms: 0,
  vendor_cost_usd: null,
  incomplete: true,
});

export const buildNoticeEnvelope = (kind: NoticeKind, reasons?: string): ResultEnvelope =>
  noticeEnvelope(noticeSummary(kind, reasons));

// A workflow that asks for a kind this CLI does not know is almost always version skew — the pinned
// CLI is older than the workflow calling it. Degrade to an honest incomplete envelope that names the
// cause rather than exiting non-zero and crashing the assemble step into posting nothing at all.
export const buildUnknownNoticeEnvelope = (kind: string): ResultEnvelope =>
  noticeEnvelope(
    `### ⚠️ Review could not be rendered\n\nThe workflow asked for an unrecognized notice kind (\`${kind}\`) — the pinned code-review CLI is older than the workflow calling it (check that its version matches). Failing closed. See the workflow logs.`,
  );
