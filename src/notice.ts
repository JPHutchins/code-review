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

export type NoticeKind =
  "security-blocked" | "triage-error" | "setup-failed" | "checkout-failed" | "no-output";

export const isNoticeKind = (s: string): s is NoticeKind =>
  s === "security-blocked" ||
  s === "triage-error" ||
  s === "setup-failed" ||
  s === "checkout-failed" ||
  s === "no-output";

// Blockquote every line so a multi-line reason stays quoted, not just its first line.
const blockquote = (text: string): string => text.replaceAll("\n", "\n> ");

// A reason-bearing notice: when the triage supplied a detail string — a genuine unsafe verdict, or
// the operational failure it hit — quote it under the lead; otherwise fall back to the no-reason
// wording.
const reasoned = (lead: string, noReason: string, reasons: string | undefined): string =>
  reasons !== undefined && reasons.trim() !== "" ? `${lead}\n\n> ${blockquote(reasons)}` : noReason;

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
        "### 🛠️ Security gate could not evaluate\n\nThe security triage could not produce a verdict (operational error), so the review failed closed. This is an infrastructure failure, not a finding about this diff — re-running the review will retry. The triage step reported:",
        "### 🛠️ Security gate could not evaluate\n\nThe security triage could not produce a verdict (operational error), so the review failed closed. This is an infrastructure failure, not a finding about this diff — re-running the review will retry. See the workflow logs.",
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

export const buildNoticeEnvelope = (kind: NoticeKind, reasons?: string): ResultEnvelope => ({
  schema_version: DEFAULT_SCHEMA_VERSION,
  findings: noticeFindings(noticeSummary(kind, reasons)),
  models: [],
  turns: 0,
  duration_ms: 0,
  vendor_cost_usd: null,
  incomplete: true,
});
