// Deterministic comment renderer. Takes findings + envelope + prices → comment markdown.
// Uses Eta templates; pure data-in, string-out — no side effects, no model invocation.

import { Eta } from "eta";
import type { Finding, Severity } from "./schema.js";
import type { RenderInput, SeverityCounts } from "./types.js";
import { computeCost } from "./cost.js";
import { severityEmoji, findingsPointer, projectPatch } from "./surface.js";
import type { PatchProjection } from "./surface.js";

/** Escape pipe characters so they don't break markdown table columns. */
const escapePipes = (text: string): string => text.replace(/\|/g, "\\|");

/** Replace backticks so they don't break inline code spans. */
const escapeCodeBackticks = (text: string): string => text.replace(/`/g, "-");

/** A stray finding with its sanitized fields plus its projected patch block for the strays list. */
type StrayView = Finding & { readonly patchProjection: PatchProjection };

/** Sanitize a stray finding's fields and attach its patch projection for the strays section. */
const sanitizeFinding = (f: Finding): StrayView => ({
  ...f,
  title: escapePipes(f.title),
  path: escapeCodeBackticks(f.path),
  patchProjection: projectPatch(f.patch),
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

/** Render a code-review comment from findings, envelope, and prices. Pure. */
export const render = (input: RenderInput): string => {
  const eta = new Eta({ autoTrim: false });
  const usageAvailable = input.envelope !== null;
  const costReport = input.envelope ? computeCost(input.envelope.models, input.prices) : null;
  const pricesProvided = input.pricesProvided ?? true;
  const route = input.route ?? input.envelope?.route ?? null;
  const effort = input.effort ?? input.envelope?.effort ?? null;
  const modelNames = input.envelope ? input.envelope.models.map((m) => m.model).join(", ") : "";

  return eta.renderString(input.template, {
    findings: input.findings,
    envelope: input.envelope,
    usageAvailable,
    costReport,
    pricesProvided,
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
    findingsPointer: input.findingsPointer ?? findingsPointer(input.findings, input.jsonUrl),
    reviewUrl: input.reviewUrl ?? null,
    formatTokens: (n: number): string =>
      Number.isFinite(n) && n >= 0 ? n.toLocaleString("en-US") : "—",
    // Cost cells render N/A (never a false $0.00) when no real price map was provided — there are
    // real tokens spent, we simply have no rates to price them (SPEC §6.2).
    formatCost: (n: number): string =>
      !pricesProvided
        ? "N/A"
        : Number.isFinite(n)
          ? n > 0 && n.toFixed(2) === "0.00"
            ? "<$0.01"
            : `$${n.toFixed(2)}`
          : "—",
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
    severityEmoji,
  });
};
