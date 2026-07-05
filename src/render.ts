// Deterministic comment renderer. Takes findings + envelope + prices → comment markdown.
// Uses Eta templates; pure data-in, string-out — no side effects, no model invocation.

import { Eta } from "eta";
import type { Finding } from "./schema.js";
import type { RenderInput } from "./types.js";
import { computeCost } from "./cost.js";

/** Escape triple-backtick sequences to prevent code-block breakout. */
const escapeBackticks = (text: string): string => text.replace(/```/g, "`` ` ``");

/** Escape pipe characters so they don't break markdown table columns. */
const escapePipes = (text: string): string => text.replace(/\|/g, "\\|");

/** Replace backticks so they don't break inline code spans. */
const escapeCodeBackticks = (text: string): string => text.replace(/`/g, "-");

/** Sanitize a finding's fields for safe rendering in the summary table. */
const sanitizeFinding = (f: Finding): Finding => ({
  ...f,
  title: escapePipes(f.title),
  path: escapeCodeBackticks(f.path),
  suggestion: f.suggestion ? escapeBackticks(f.suggestion) : f.suggestion,
});

/** Render a code-review comment from findings, envelope, and prices. Pure. */
export const render = (input: RenderInput): string => {
  const eta = new Eta({ autoTrim: false });
  const usageAvailable = input.envelope !== null;
  const costReport = input.envelope ? computeCost(input.envelope.models, input.prices) : null;
  const route = input.route ?? input.envelope?.route ?? null;
  const effort = input.effort ?? input.envelope?.effort ?? null;
  const modelNames = input.envelope ? input.envelope.models.map((m) => m.model).join(", ") : "";

  const findings = input.findings.findings.map(sanitizeFinding);
  const safeFindings = { ...input.findings, findings };
  const uniqueFiles = [...new Set(findings.map((f) => f.path))];

  return eta.renderString(input.template, {
    findings: safeFindings,
    envelope: input.envelope,
    usageAvailable,
    costReport,
    route,
    effort,
    modelNames,
    testReport: input.testReport ?? null,
    reviewedSha: input.reviewedSha ?? "0000000000000000000000000000000000000000",
    totalCount: findings.length,
    fileCount: uniqueFiles.length,
    // REC-CO-1: nits (and only nits) fold into <details>; everything else stays visible.
    visibleFindings: findings.filter((f) => f.severity !== "nit"),
    nitFindings: findings.filter((f) => f.severity === "nit"),
    suggestionCount: findings.filter((f) => f.suggestion).length,
    formatTokens: (n: number): string =>
      Number.isFinite(n) && n >= 0 ? n.toLocaleString("en-US") : "—",
    formatCost: (n: number): string => (Number.isFinite(n) ? `$${n.toFixed(3)}` : "—"),
    formatDuration: (ms: number): string => {
      if (!Number.isFinite(ms) || ms < 0) return "—";
      const s = Math.round(ms / 1000);
      return s >= 60 ? `${String(Math.floor(s / 60))}m ${String(s % 60)}s` : `${String(s)}s`;
    },
    verdictBadge: (v: string): string => {
      switch (v) {
        case "approve":
          return "✅ approved";
        case "comment":
          return "💬 comment";
        case "changes":
          return "🔧 changes requested";
        default:
          return `❓ ${v}`;
      }
    },
    severityEmoji: (s: string): string => {
      switch (s) {
        case "critical":
          return "🔴";
        case "major":
          return "🟠";
        case "minor":
          return "🔵";
        case "nit":
          return "⚪";
        default:
          return "❓";
      }
    },
  });
};
