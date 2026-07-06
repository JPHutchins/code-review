// Deterministic comment renderer. Takes findings + envelope + prices → comment markdown.
// Uses Eta templates; pure data-in, string-out — no side effects, no model invocation.

import { Eta } from "eta";
import type { Finding, Severity } from "./schema.js";
import type { RenderInput, SeverityCounts } from "./types.js";
import { computeCost } from "./cost.js";

/** Escape triple-backtick sequences to prevent code-block breakout. */
const escapeBackticks = (text: string): string => text.replace(/```/g, "`` ` ``");

/** Escape pipe characters so they don't break markdown table columns. */
const escapePipes = (text: string): string => text.replace(/\|/g, "\\|");

/** Replace backticks so they don't break inline code spans. */
const escapeCodeBackticks = (text: string): string => text.replace(/`/g, "-");

/** Sanitize a finding's fields for safe rendering in the strays section. */
const sanitizeFinding = (f: Finding): Finding => ({
  ...f,
  title: escapePipes(f.title),
  path: escapeCodeBackticks(f.path),
  suggestion: f.suggestion ? escapeBackticks(f.suggestion) : f.suggestion,
});

const emptySeverityCounts = (): Record<Severity, number> => ({
  critical: 0,
  major: 0,
  minor: 0,
  nit: 0,
});

/** Tally findings by severity for the summary counts line. Ignores out-of-domain severities. */
export const computeSeverityCounts = (findings: readonly Finding[]): SeverityCounts =>
  findings.reduce<Record<Severity, number>>(
    (acc, f) => (f.severity in acc ? { ...acc, [f.severity]: acc[f.severity] + 1 } : acc),
    emptySeverityCounts(),
  );

/** Base64 chars (~30KB JSON); keeps the sticky well under GitHub's 65536-char comment limit. */
const EMBED_LIMIT = 40000;

/** Render a code-review comment from findings, envelope, and prices. Pure. */
export const render = (input: RenderInput): string => {
  const eta = new Eta({ autoTrim: false });
  const usageAvailable = input.envelope !== null;
  const costReport = input.envelope ? computeCost(input.envelope.models, input.prices) : null;
  const route = input.route ?? input.envelope?.route ?? null;
  const effort = input.effort ?? input.envelope?.effort ?? null;
  const modelNames = input.envelope ? input.envelope.models.map((m) => m.model).join(", ") : "";
  const findingsB64 = Buffer.from(JSON.stringify(input.findings), "utf-8").toString("base64");
  const embeddedFindings = findingsB64.length <= EMBED_LIMIT ? findingsB64 : null;

  return eta.renderString(input.template, {
    findings: input.findings,
    envelope: input.envelope,
    usageAvailable,
    costReport,
    route,
    effort,
    modelNames,
    testReport: input.testReport ?? null,
    reviewedSha: input.reviewedSha ?? "0000000000000000000000000000000000000000",
    severityCounts: input.severityCounts ?? computeSeverityCounts(input.findings.findings),
    strays: (input.strays ?? []).map(sanitizeFinding),
    inlineDisposition: input.inlineDisposition ?? null,
    runUrl: input.runUrl ?? null,
    jsonUrl: input.jsonUrl ?? null,
    embeddedFindings,
    reviewUrl: input.reviewUrl ?? null,
    formatTokens: (n: number): string =>
      Number.isFinite(n) && n >= 0 ? n.toLocaleString("en-US") : "—",
    formatCost: (n: number): string =>
      Number.isFinite(n) ? (n > 0 && n.toFixed(2) === "0.00" ? "<$0.01" : `$${n.toFixed(2)}`) : "—",
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
