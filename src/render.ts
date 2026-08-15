// Pure data-in, string-out Eta rendering — no side effects, no model invocation.

import { Eta } from "eta";
import type { Finding, Severity, SystemicProblem, Verdict } from "./schema.js";
import { isIncompleteFindings } from "./schema.js";
import type { RenderInput, SeverityCounts } from "./types.js";
import { computeCost } from "./cost.js";
import {
  severityEmoji,
  projectPatch,
  formatConfidence,
  roundsSummary,
  convergenceSummary,
  convergenceBadge,
  changeSizeSummary,
  computeSameRootNotes,
  metastasisNote,
  findingsPointer,
  escapeCodeBackticks,
  escapeFence,
  DEFAULT_NIT_VISIBILITY_FLOOR,
} from "./surface.js";
import { answeredNoteKey } from "./answered.js";
import type { PatchProjection } from "./surface.js";

// pipes break markdown table columns.
const escapePipes = (text: string): string => text.replace(/\|/g, "\\|");

type StrayView = Finding & {
  readonly patchProjection: PatchProjection;
  readonly answeredNote: string;
};

// The per-stray "re-raised; prior answer" note, resolved HERE from the RAW finding's key — the
// title is sanitized for rendering (escapePipes) but the note key was built from the raw title, so
// a template-side lookup against the sanitized title would miss on a pipe/backtick title (issue
// #151 review r2). The template renders the precomputed note.
const sanitizeFinding = (
  f: Finding,
  answeredNotes: Readonly<Record<string, string>> | undefined,
): StrayView => {
  const key = answeredNoteKey(f);
  return {
    ...f,
    title: escapePipes(f.title),
    path: escapeCodeBackticks(f.path),
    patchProjection: projectPatch(f.patch),
    answeredNote:
      answeredNotes !== undefined && Object.prototype.hasOwnProperty.call(answeredNotes, key)
        ? (answeredNotes[key] ?? "")
        : "",
  };
};

// The suppressed-nit aside sits inside a `> [!NOTE]` blockquote, so a reviewer-supplied newline in a
// title or path would break out of it (the hazard escapeCodeBackticks documents — it collapses
// newlines AND neutralizes backticks). `m` is the confidence × likelihood the floor compared against,
// shown so a maintainer who expands the aside sees WHY each nit was shelved (issue #164).
type SuppressedNitView = {
  readonly title: string;
  readonly code?: string;
  readonly path: string;
  readonly startLine: number;
  readonly m: string;
};
const sanitizeSuppressedNit = (f: Finding): SuppressedNitView => ({
  title: escapeCodeBackticks(f.title),
  ...(f.code !== undefined ? { code: escapeCodeBackticks(f.code) } : {}),
  path: escapeCodeBackticks(f.path),
  startLine: f.start_line,
  m: formatConfidence(f.confidence * f.likelihood),
});

// The same render-safety escaping as strays: pipes break tables, backticks break inline code spans.
// finding_codes render inside backticks too, so they get the same backtick escaping as paths.
const sanitizeSystemic = (s: SystemicProblem): SystemicProblem => ({
  ...s,
  title: escapePipes(s.title),
  ...(s.paths !== undefined ? { paths: s.paths.map(escapeCodeBackticks) } : {}),
  ...(s.finding_codes !== undefined
    ? { finding_codes: s.finding_codes.map(escapeCodeBackticks) }
    : {}),
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
  const costReport = input.envelope
    ? computeCost(input.envelope.models, input.prices, input.pricedAt)
    : null;
  const pricesProvided = input.pricesProvided ?? true;
  const route = input.route ?? input.envelope?.route ?? null;
  const effort = input.effort ?? input.envelope?.effort ?? null;
  const modelNames = input.envelope ? input.envelope.models.map((m) => m.model).join(", ") : "";
  const severityCounts = input.severityCounts ?? computeSeverityCounts(input.findings.findings);
  // The pipeline-stamped convergence field (issue #174) is the source for the trajectory and the badge.
  // `input.rounds` is a fallback only for callers that supply a legacy trajectory directly (tests, or a
  // standalone render of a doc without convergence); its entries carry no score and render "—". Every
  // production sticky carries convergence in the blob, so the fallback never fires there.
  const convergence = input.findings.convergence;
  const trajectory = convergence?.rounds ?? input.rounds ?? [];
  // The same-root annotation: post passes the explicit map computed from the PRIOR-round history it
  // parsed before appending this run's record; the standalone render command derives it from the
  // supplied history minus its last (current) round. Keyed by code, rendered under each finding that
  // carries it; empty when nothing recurs — no annotation.
  const sameRootNotes =
    input.sameRootNotes ?? computeSameRootNotes(trajectory.slice(0, -1), input.findings.findings);
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
    (input.convergenceRound ?? (isConvergenceRound(route, incomplete) && trajectory.length > 0)) &&
    isReviewVerdict(input.findings.verdict);

  // The badge and the trajectory both read the ONE pipeline-stamped `convergence` field (issue #174),
  // whose score is per-finding — reading confidence × likelihood off the findings themselves, not a
  // round's aggregate counts (issue #162) — so by construction they can never disagree (issue #141
  // review r2). In the post path this run is the last stored round, so the stamped score matches the
  // trajectory's last chip; the score already weighs a systemic critical like a finding critical (issue #134 scope).
  // The advisory notes (same-root + scope-metastasis) are a property of a real review, gated by the
  // same decision as the badge (a completed FULL-REVIEW round): a mechanic pass or a lost-envelope
  // completed review must not render a "still recurring" claim from carried-forward rounds beside a
  // suppressed convergence badge.
  const advisoryAllowed = isFullReviewRound;

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
    // The agent's best-effort role split (issue #182) and the pipeline's deterministic cloc table; both
    // chrome, gated to a completed review by the template's !incomplete block.
    changeSummary: changeSizeSummary(input.findings.change_size),
    clocDiff: input.clocDiff !== undefined ? escapeFence(input.clocDiff) : null,
    reviewedSha: input.reviewedSha ?? "0000000000000000000000000000000000000000",
    postedAt: input.postedAt ?? "",
    severityCounts,
    convergenceSummary: !isFullReviewRound
      ? ""
      : convergence
        ? convergenceBadge(convergence)
        : convergenceSummary(input.findings, input.convergenceThreshold),
    strays: (input.strays ?? []).map((f) => sanitizeFinding(f, input.answeredNotes)),
    suppressedNits: (input.suppressedNits ?? []).map(sanitizeSuppressedNit),
    nitVisibilityFloor: input.nitVisibilityFloor ?? DEFAULT_NIT_VISIBILITY_FLOOR,
    systemic: (input.findings.systemic_problems ?? []).map(sanitizeSystemic),
    unanchoredCount: input.unanchoredCount ?? 0,
    inlineDisposition: input.inlineDisposition ?? null,
    runUrl: input.runUrl ?? null,
    jsonUrl: input.jsonUrl ?? null,
    // The blob is the agent's complete document with the pipeline-stamped convergence field inside it
    // (issue #174) — no separate signal or rounds marker rides beside it. post always supplies the
    // precomputed marker; the standalone `render` command falls back to encoding the doc here.
    findingsPointer: input.findingsPointer ?? findingsPointer(input.findings, input.jsonUrl),
    roundsSummary: roundsSummary(trajectory, input.roundCount),
    metastasisNote: advisoryAllowed ? metastasisNote(trajectory) : "",
    sameRootNotes: advisoryAllowed ? sameRootNotes : {},
    answeredNotes: input.answeredNotes ?? {},
    answeredReRaiseNote: input.answeredReRaiseNote ?? "",
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
