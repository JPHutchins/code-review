// Pure data-in, string-out Eta rendering — no side effects, no model invocation.

import { Eta } from "eta";
import type { Finding, Severity, Verdict } from "./schema.js";
import { isIncompleteFindings } from "./schema.js";
import type { RenderInput, SeverityCounts } from "./types.js";
import { computeCost } from "./cost.js";
import {
  severityEmoji,
  projectPatch,
  formatConfidence,
  roundsMarker,
  roundsSummary,
  convergenceSummary,
  signalForRound,
  surfacedFindingsPointer,
} from "./surface.js";
import type { PatchProjection } from "./surface.js";

// pipes break markdown table columns.
const escapePipes = (text: string): string => text.replace(/\|/g, "\\|");

// backticks break inline code spans.
const escapeCodeBackticks = (text: string): string => text.replace(/`/g, "-");

type StrayView = Finding & { readonly patchProjection: PatchProjection };

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

export const computeSeverityCounts = (findings: readonly Finding[]): SeverityCounts =>
  findings.reduce<Record<Severity, number>>(
    (acc, f) => (f.severity in acc ? { ...acc, [f.severity]: acc[f.severity] + 1 } : acc),
    emptySeverityCounts(),
  );

// The other half of the round decision, shared by post (round append) and render (badge): "error"
// is the pipeline-reserved no-verdict value, so a doc that carries it — even one that somehow also
// carries findings — never counts as a completed review and must never read as converged (#141).
export const isReviewVerdict = (verdict: Verdict): boolean => verdict !== "error";

// The single decision "is THIS run a convergence-defining full-review round?" — a completed full
// review (not a CI-fix mechanic pass, not an incomplete notice). post() calls it to decide the round
// append AND passes the result to render() for the badge gate, so the two can never disagree; render()
// falls back to it only for the standalone `render` command, which has no post to compute it.
export const isConvergenceRound = (
  route: string | null | undefined,
  incomplete: boolean,
): boolean => route === "full review" && !incomplete;

export const render = (input: RenderInput): string => {
  const eta = new Eta({ autoTrim: false });
  const usageAvailable = input.envelope !== null;
  // The meta line prints turns/cost only when there is real usage to print — a present-but-zeroed
  // envelope (the synthesized notice wrap: no models) would otherwise show a false "$0.00 · turns 0".
  const hasUsage = input.envelope !== null && input.envelope.models.length > 0;
  // Enforce the invariant here, not just at the producers: a no-verdict notice (isIncompleteFindings)
  // is ALWAYS incomplete however it reached render (an envelope-less notice, a recovered draft), so it
  // never renders "clean review" or the review-complete marker.
  const incomplete =
    (input.incomplete ?? input.envelope?.incomplete ?? false) ||
    isIncompleteFindings(input.findings);
  const costReport = input.envelope ? computeCost(input.envelope.models, input.prices) : null;
  const pricesProvided = input.pricesProvided ?? true;
  const route = input.route ?? input.envelope?.route ?? null;
  const effort = input.effort ?? input.envelope?.effort ?? null;
  const modelNames = input.envelope ? input.envelope.models.map((m) => m.model).join(", ") : "";
  const severityCounts = input.severityCounts ?? computeSeverityCounts(input.findings.findings);
  const rounds = input.rounds ?? [];
  // The convergence badge is a property of a completed FULL-REVIEW round: render it only then, from
  // the completed round's counts. A CI-fix mechanic pass, a lost-envelope pass, and a notice each
  // append no round and declare no convergence verdict — a badge from the current findings would sit
  // "converged" above a mechanic's fresh critical, and one from a carried-forward prior round would
  // contradict the findings beside it. Neither is a truthful stop signal, so no badge shows; the
  // carried-forward trajectory alone gives context. Prefer post's explicit signal (which also gates
  // the round append, so badge ⇔ append); fall back to the shared predicate for the standalone
  // `render` command — which additionally requires a rounds history, since without one no round has
  // completed and neither the badge nor the blob's stop signal may appear (the README's omission
  // semantics, issue #141 review r4). The verdict guard (isReviewVerdict, shared with post's round
  // append) closes an edge isIncompleteFindings misses (it flags an "error" verdict only when
  // findings are also empty): an error doc that carries findings must still show no badge, never
  // "converged" beside the "no review verdict" badge.
  const isFullReviewRound =
    (input.convergenceRound ?? (isConvergenceRound(route, incomplete) && rounds.length > 0)) &&
    isReviewVerdict(input.findings.verdict);

  // The convergence counts the badge AND the fallback blob signal both derive from — the last
  // completed round when a history exists (post-style histories end with THIS run), else this run's
  // own counts — one source, so the two can never disagree (issue #141 review r2).
  const convergenceCounts = rounds[rounds.length - 1] ?? severityCounts;

  return eta.renderString(input.template, {
    findings: input.findings,
    envelope: input.envelope,
    usageAvailable,
    hasUsage,
    incomplete,
    costReport,
    pricesProvided,
    route,
    effort,
    modelNames,
    testReport: input.testReport ?? null,
    reviewedSha: input.reviewedSha ?? "0000000000000000000000000000000000000000",
    postedAt: input.postedAt ?? "",
    severityCounts,
    convergenceSummary: isFullReviewRound
      ? convergenceSummary(convergenceCounts, input.convergenceThreshold)
      : "",
    strays: (input.strays ?? []).map(sanitizeFinding),
    unanchoredCount: input.unanchoredCount ?? 0,
    inlineDisposition: input.inlineDisposition ?? null,
    runUrl: input.runUrl ?? null,
    jsonUrl: input.jsonUrl ?? null,
    findingsPointer:
      input.findingsPointer ??
      surfacedFindingsPointer(
        input.findings,
        // The fallback embeds a signal exactly when the badge renders — never beside a suppressed
        // badge, and from the same counts the badge reads. It assumes a post-style history (the
        // caller appends this run's counts last), numbering the round exactly as the trajectory
        // label does; post always supplies the marker, so this path cannot disagree with it in
        // production (issue #141 review r4).
        isFullReviewRound && rounds.length > 0
          ? signalForRound(rounds.length, convergenceCounts, input.convergenceThreshold)
          : null,
        input.jsonUrl,
      ),
    roundsMarker: roundsMarker(rounds),
    roundsSummary: roundsSummary(rounds, input.roundCount),
    reviewUrl: input.reviewUrl ?? null,
    formatTokens: (n: number): string =>
      Number.isFinite(n) && n >= 0 ? n.toLocaleString("en-US") : "—",
    // N/A (never a false $0.00) when no real price map was provided — real tokens, no rates to price them.
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
        case "error":
          return "🛠️ no review verdict";
        default:
          return `❓ ${v}`;
      }
    },
    severityEmoji,
    formatConfidence,
  });
};
