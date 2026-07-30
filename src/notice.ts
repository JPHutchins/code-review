// The notices the review workflow synthesizes when there is no completed review to post: a security
// block, a setup failure before triage could run, a diff that would not apply, or a run that passed
// triage but emitted nothing. Their messages and the "incomplete" envelope shape live here — one
// typed SSOT — rather than as jq object literals spread across the workflow YAML, so the commenter
// renders every one honestly (no false "clean review"/"$0.00") and the sticky precedence guard treats
// them as non-completing.

import { DEFAULT_SCHEMA_VERSION, noticeFindings } from "./schema.js";
import type { ResultEnvelope } from "./schema.js";

export type NoticeKind = "security-blocked" | "setup-failed" | "diff-apply-failed" | "no-output";

export const isNoticeKind = (s: string): s is NoticeKind =>
  s === "security-blocked" ||
  s === "setup-failed" ||
  s === "diff-apply-failed" ||
  s === "no-output";

const noticeSummary = (kind: NoticeKind, reasons: string | undefined): string => {
  switch (kind) {
    case "security-blocked":
      return reasons !== undefined && reasons.trim() !== ""
        ? `### 🛑 Code review skipped by the security gate\n\nThe diff was flagged as unsafe to apply and execute:\n\n> ${reasons}`
        : "### 🛑 Code review skipped by the security gate\n\nThe security triage returned an unsafe verdict without a reason. See workflow logs.";
    case "setup-failed":
      return "### 🛠️ Review did not run\n\nThe review job failed before the security triage could run (e.g. dependency install or environment setup). See the workflow logs — this is an infrastructure failure, not a security verdict.";
    case "diff-apply-failed":
      return "### ⚠️ Could not apply the diff\n\nThe PR diff could not be applied to the checked-out base commit, so the review was skipped rather than run against an unmodified tree. See workflow logs.";
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
