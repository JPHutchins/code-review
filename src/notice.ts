// The notices the review workflow synthesizes when there is no completed review to post: a security
// block (triage returned a genuine unsafe verdict), a triage that could not evaluate (an operational
// failure, not a verdict about the diff), a setup failure before triage could run, a PR head that
// would not check out, or a run that passed triage but emitted nothing. Their messages and the
// "incomplete" envelope shape live here — one typed SSOT — rather than as jq object literals spread
// across the workflow YAML, so the commenter renders every one honestly (no false "clean
// review"/"$0.00", and an operational failure never reads as a security verdict about the diff) and
// the sticky precedence guard treats them as non-completing.

import { DEFAULT_SCHEMA_VERSION, incompleteFindings } from "./schema.js";
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

// A host is safe to name in the raw-rendered, grep-scanned summary only if it can neither break out of
// its backtick code span (`) nor forge a comment marker (<, >) nor start a new line (\n, \r) or table
// cell (|). This is a render-safety denylist, NOT a hostname grammar: it keeps legitimate but unusual
// hosts (bracketed IPv6, IDN) a strict pattern would wrongly drop, while still neutralizing a tampered
// sandbox.json (the agent can rewrite it — the jail confines egress, not the filesystem). Shared with
// scope.ts, whose scope values are spliced into the review prompt and must reject exactly these
// prompt-structure breakers (issue #139).
export const UNSAFE_IN_SUMMARY = /[\n\r`<>|]/;

// Cap how many hosts are named: a tampered config could pad allowedDomains until the rendered summary
// blows past GitHub's 65536-char comment limit and the comment fails to post at all. A real allowlist
// is a handful; the count is the diagnostic signal, not every entry.
const MAX_NAMED_HOSTS = 20;

// The review agent's egress jail (sandbox-runtime) confines ONLY the agent — setup, install, and
// gather run unfiltered. So when a jailed run produced no review, naming the jail's allowlist turns
// "the agent could not reach a host it needed" into a one-line diagnosis. Pure: pulls
// network.allowedDomains out of a parsed sandbox config, keeping only render-safe, sanely-sized host
// strings (capped) and yielding none for any other shape (a missing config, or one before jail setup).
export const parseAgentAllowlist = (sandboxConfig: unknown): readonly string[] => {
  const domains = (sandboxConfig as { network?: { allowedDomains?: unknown } } | null | undefined)
    ?.network?.allowedDomains;
  return Array.isArray(domains)
    ? domains
        .filter(
          (d): d is string =>
            typeof d === "string" && d.length <= 256 && !UNSAFE_IN_SUMMARY.test(d),
        )
        .slice(0, MAX_NAMED_HOSTS)
    : [];
};

// Appended only to the notices where a jailed `claude -p` actually ran (no-output, triage-error), so
// an egress-blocked host it needed is nameable against the allowlist. Framed conditionally — these
// notices also fire for non-egress causes (a missing key, a wall-clock kill) — so it informs without
// asserting egress was the cause. Empty allowlist ⇒ empty note.
const egressNote = (agentAllowlist: readonly string[]): string =>
  agentAllowlist.length === 0
    ? ""
    : `\n\nIf the review failed because the agent could not reach a host it needed, note that its network egress is jailed to only ${agentAllowlist
        .map((host) => `\`${host}\``)
        .join(
          ", ",
        )}. Add any missing host to the agent's egress allowlist — the reusable workflow's \`extra_endpoints\` input, or a single-file workflow's \`--extra\` flag on \`sandbox-config\`.`;

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

const noticeSummary = (
  kind: NoticeKind,
  reasons: string | undefined,
  agentAllowlist: readonly string[],
): string => {
  switch (kind) {
    case "security-blocked":
      return reasoned(
        "### 🛑 Code review skipped by the security gate\n\nThe diff was flagged as unsafe to apply and execute:",
        "### 🛑 Code review skipped by the security gate\n\nThe security triage returned an unsafe verdict without a reason. See workflow logs.",
        reasons,
      );
    case "triage-error":
      return (
        reasoned(
          "### 🛠️ Security gate could not evaluate\n\nThe security triage could not produce a verdict (operational error), so the review failed closed — this is an infrastructure failure, not a finding about this diff. Re-run to retry a transient fault; a persistent one is a configuration issue (see the workflow logs). The triage step reported:",
          "### 🛠️ Security gate could not evaluate\n\nThe security triage could not produce a verdict (operational error), so the review failed closed — this is an infrastructure failure, not a finding about this diff. Re-run to retry a transient fault; a persistent one is a configuration issue (see the workflow logs).",
          reasons,
        ) + egressNote(agentAllowlist)
      );
    case "setup-failed":
      return "### 🛠️ Review did not run\n\nThe review job failed before the security triage could run (e.g. dependency install or environment setup). See the workflow logs — this is an infrastructure failure, not a security verdict.";
    case "checkout-failed":
      return "### ⚠️ Could not check out the PR head\n\nThe PR head commit could not be fetched or checked out (it may have been force-pushed away, or is otherwise unavailable), so the review was skipped rather than run against the wrong tree. See workflow logs.";
    case "no-output":
      return (
        "### ⚠️ Review did not complete\n\nThe diff passed triage but the review produced no output. See workflow logs." +
        egressNote(agentAllowlist)
      );
  }
};

const noticeEnvelope = (summary: string): ResultEnvelope => ({
  schema_version: DEFAULT_SCHEMA_VERSION,
  findings: incompleteFindings(summary),
  models: [],
  turns: 0,
  duration_ms: 0,
  vendor_cost_usd: null,
  incomplete: true,
});

export const buildNoticeEnvelope = (
  kind: NoticeKind,
  reasons?: string,
  agentAllowlist: readonly string[] = [],
): ResultEnvelope => noticeEnvelope(noticeSummary(kind, reasons, agentAllowlist));

// A workflow that asks for a kind this CLI does not know is almost always version skew — the pinned
// CLI is older than the workflow calling it. Degrade to an honest incomplete envelope that names the
// cause rather than exiting non-zero and crashing the assemble step into posting nothing at all.
export const buildUnknownNoticeEnvelope = (kind: string): ResultEnvelope =>
  noticeEnvelope(
    `### ⚠️ Review could not be rendered\n\nThe workflow asked for an unrecognized notice kind (\`${kind}\`) — the pinned code-review CLI is older than the workflow calling it (check that its version matches). Failing closed. See the workflow logs.`,
  );
