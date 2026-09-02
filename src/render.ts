// Pure data-in, string-out Eta rendering — no side effects, no model invocation.

import { Eta } from "eta";
import { BODY_CLIP_CHARS, clipText } from "./util.js";
import type { Finding, Severity, SystemicProblem, Verdict } from "./schema.js";
import { isIncompleteFindings, resolveFindingId } from "./schema.js";
import type { DiscussionLink, RenderInput, SeverityCounts } from "./types.js";
import { computeCost, parseInstant } from "./cost.js";
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
  findingsMarkerPair,
  escapeCodeBackticks,
  escapeFence,
  lineRange,
  DEFAULT_NIT_VISIBILITY_FLOOR,
} from "./surface.js";
import { answeredNoteKey } from "./answered.js";
import type { PatchProjection } from "./surface.js";

// pipes break markdown table columns.
const escapePipes = (text: string): string => text.replace(/\|/g, "\\|");

// A code renders inside backticks and a code_url inside a markdown link: a backtick in the code
// breaks the span, and a paren/newline in the URL breaks the link (or the blockquote the nit's
// aside sits in) — issue #233 r2. The newline/backtick handling is escapeCodeBackticks' own.
// The paren policy has ONE owner: an unbalanced paren truncates GitHub's autolink, so every
// URL-building surface on the sticky shares this encoding (issue #231 r2).
const encodeAutolinkParens = (url: string): string =>
  url.replace(/\(/g, "%28").replace(/\)/g, "%29");

const linkSafeUrl = (url: string): string => encodeAutolinkParens(escapeCodeBackticks(url));

// A stray finding the sticky lists links back to its code at the reviewed SHA: a BARE URL — GitHub
// autolinks it and sizes the rendering sensibly, where the nested-aside `<details>` permalink JP
// prototyped renders dead in issue comments (issue #231). Each segment is percent-encoded: lone
// surrogates are replaced with U+FFFD first (encodeURIComponent THROWS on them — a junk path must
// degrade, never crash the post), then parens after it (an unbalanced paren truncates GitHub's
// autolink; linkSafeUrl's policy — issue #231 r1). Returns null for the findings a link would lie
// about: a LEFT-side finding (its line numbers index the BASE tree, so a head-blob anchor names
// the wrong code) and an empty path. `anchor` false links the path only — a stray GitHub rejected
// inline must not re-assert its known-bad coordinates as an exact anchor.
const permalinkFor = (base: string, f: Finding, anchor: boolean): string | undefined => {
  if (f.path === "" || f.side === "LEFT") return undefined;
  const path = f.path
    .split("/")
    .map((segment) =>
      encodeAutolinkParens(
        encodeURIComponent(
          segment.replace(
            /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
            "�",
          ),
        ),
        // Markdown emphasis/syntax characters: `__` runs split the bare URL across CommonMark
        // nodes and truncate the autolink, and a path-only link ending in one of these loses its
        // tail to the autolinker's trailing-punctuation trim (issue #231 r4).
      )
        .replace(/_/g, "%5F")
        .replace(/\*/g, "%2A")
        .replace(/'/g, "%27")
        .replace(/!/g, "%21"),
    )
    .join("/");
  return anchor ? `${base}${path}#L${lineRange(f.start_line, f.end_line, "-L")}` : `${base}${path}`;
};

// The machine-channel budget for suppressed-nit blocks: each field is clipped individually
// (BODY_CLIP_CHARS), but the SUM across a nit-heavy round is unbounded, and the sticky is the one
// comment post deliberately does not shed — an unbounded machine block can still 422 it, which the
// old embed-limit valve structurally prevented (issue #233 r1). The budget counts each nit's
// WHOLE block — the carried lines plus the fixed summary/severity/location/`-->` lines and their
// blockquote prefixes — and drops a nit's entire block once exhausted. The cut is marked in the
// machine channel, never silent (issue #233 r5).
const CARRIED_TOTAL_CHARS = 40_000;
const SUPPRESSED_NIT_BLOCK_OVERHEAD = 280;

// The discussion surface's budget: the per-finding asides AND the orphaned "earlier rounds"
// section are additive to the one body post never sheds, so a discussion-heavy round drops whole
// asides past this total — the cut is named in the template, never silent (the same discipline
// the suppressed-nit budget applies). The orphaned section draws FIRST: its cut is permanent (a
// departed id never re-enters a prior round's findings, so a dropped orphan is never re-listed),
// while an aside cut recovers next round when the finding is still current.
const DISCUSSION_TOTAL_CHARS = 8_000;
const DISCUSSION_BLOCK_OVERHEAD = 120;
// The orphaned entry's fixed wrapper (bullet, `**` bold + backtick span, colon, newline) — the
// links themselves are budgeted at their true rendered size like every other link list.
const ORPHANED_ENTRY_OVERHEAD = 14;
// The newest-first cap every discussion list keeps (per-finding, per-orphan-token, and the
// suppressed aside's slots). LIVES HERE so the template's "showing the N newest of M" notes
// interpolate it — a cap change cannot leave a rendered note lying.
export const PER_FINDING_LINKS = 6;

// The shared "budget by rendered size" walk both collateral asides use: items are added in order
// while the ACCUMULATED size fits the cap; past it, onDrop decides each dropped item's fate
// (null drops it entirely, a transformed item stays rendered emptied). The two budgets were
// near-twins that drifted into a dead-budget bug — one walk, one cap comparison.
const budgetBySize = <T>(
  items: readonly T[],
  cap: number,
  sizeOf: (item: T) => number,
  onDrop: (item: T) => T | null,
): { readonly kept: readonly T[]; readonly droppedItems: readonly T[]; readonly used: number } => {
  const kept: T[] = [];
  const droppedItems: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (used + size > cap) {
      droppedItems.push(item);
      const replaced = onDrop(item);
      if (replaced !== null) kept.push(replaced);
      continue;
    }
    kept.push(item);
    used += size;
  }
  return { kept, droppedItems, used };
};

// A discussion link list's rendered size: author + date + url plus each link's `- [ · ]()` wrapper.
const discussionLinksCost = (links: readonly DiscussionLink[]): number =>
  links.reduce((sum, d) => sum + d.author.length + d.when.length + d.url.length, 0) +
  links.length * 12;

type StrayView = Finding & {
  readonly patchProjection: PatchProjection;
  readonly answeredNote: string;
  // The RAW id, carried beside the escaped display form: the same-root note lookup in the
  // template is keyed on raw ids, so a backtick/newline id must not lose its note through
  // the escaping (issue #233 r3).
  readonly idKey: string;
  // The heading's collapsed line range (`start–end` via the shared lineRange collapse, so the
  // heading and the permalink anchor can never disagree — issue #231 r1).
  readonly rangeLabel: string;
  // Pre-encoded bare permalink to the finding's code at the reviewed SHA (issue #231); absent when
  // the caller supplies no repo (the standalone render command), for a LEFT-side finding (its
  // coordinates index the base tree), or for an empty path.
  readonly permalink?: string;
  // False for a stray GitHub rejected inline: its permalink links the path only, so the template
  // can tell an anchored link (which carries the agent-reported qualifier) from a bare one.
  readonly permalinkAnchored?: boolean;
  // Replies to the sticky comment that mention this finding's id (issue #246): the discussion
  // aside's linked list — pointers only, never reply prose.
  readonly discussion: readonly DiscussionLink[];
  // The pre-cap reply count when the 6-newest cap trimmed this finding's list — the aside names
  // its cut instead of rendering indistinguishably from a short thread.
  readonly discussionTruncated?: number;
};

// The per-stray "re-raised; prior answer" note, resolved HERE from the RAW finding's key — the
// title is sanitized for rendering (escapePipes) but the note key was built from the raw title, so
// a template-side lookup against the sanitized title would miss on a pipe/backtick title (issue
// #151 review r2). The template renders the precomputed note.
const sanitizeFinding = (
  f: Finding,
  answeredNotes: Readonly<Record<string, string>> | undefined,
  discussionByFinding: Readonly<Record<string, readonly DiscussionLink[]>> | undefined,
  permalinkBase?: string,
  unanchored?: ReadonlySet<Finding>,
  discussionTruncated?: Readonly<Record<string, number>>,
): StrayView => {
  const key = answeredNoteKey(f);
  // Reference identity, not a location key: post spreads the SAME finding objects into both
  // arrays, so the rejected set un-anchors exactly the findings GitHub rejected — a string key
  // would also demote a distinct twin finding at the same coordinates (issue #231 r2).
  const anchored = permalinkBase !== undefined && !(unanchored?.has(f) ?? false);
  const permalink =
    permalinkBase === undefined ? undefined : permalinkFor(permalinkBase, f, anchored);
  // permalinkBase undefined AND a LEFT/empty-path omission both land on `undefined`, so the spread
  // below is truly absent for every no-permalink case — the StrayView contract (issue #231 r4).
  return {
    ...f,
    title: escapePipes(f.title),
    path: escapeCodeBackticks(f.path),
    id: escapeCodeBackticks(f.id),
    // The RESOLVED id: the same-root notes are keyed on resolveFindingId (an empty id resolves to
    // its synthesized key), so the lookup must not miss the note on the raw id.
    idKey: resolveFindingId(f),
    ...(f.code_url !== undefined ? { code_url: linkSafeUrl(f.code_url) } : {}),
    rangeLabel: lineRange(f.start_line, f.end_line, "–"),
    ...(permalink !== undefined ? { permalink, permalinkAnchored: anchored } : {}),
    patchProjection: projectPatch(f.patch, "comment-body"),
    answeredNote:
      answeredNotes !== undefined && Object.prototype.hasOwnProperty.call(answeredNotes, key)
        ? (answeredNotes[key] ?? "")
        : "",
    discussion:
      discussionByFinding !== undefined &&
      Object.prototype.hasOwnProperty.call(discussionByFinding, f.id)
        ? (discussionByFinding[f.id] ?? [])
        : [],
    ...(discussionTruncated !== undefined &&
    Object.prototype.hasOwnProperty.call(discussionTruncated, f.id)
      ? { discussionTruncated: discussionTruncated[f.id] }
      : {}),
  };
};

// The suppressed-nit aside sits inside a `> [!NOTE]` blockquote, so a reviewer-supplied newline in a
// title or path would break out of it (the hazard escapeCodeBackticks documents — it collapses
// newlines AND neutralizes backticks). `m` is the confidence × likelihood the floor compared against,
// shown so a maintainer who expands the aside sees WHY each nit was shelved (issue #164).
// A below-floor nit is HIDDEN from the human list by policy (issue #164) — that is a visibility
// decision, and it must not become a content filter. The projection used to keep 5 of a finding's 14
// fields, which meant description, recommendation, reasoning and patch existed nowhere in the comment;
// harmless while the document rode along as base64, a real hole once the document moved to the
// artifact (issue #217). Everything now travels: the summary line stays exactly as it was, and the
// rest rides the machine channel beside it, where a hidden nit's detail belongs.
type SuppressedNitView = {
  readonly title: string;
  readonly id: string;
  readonly codeUrl?: string;
  readonly path: string;
  // The machine location line renders start-end ALWAYS FULL (plain hyphen, no collapse) — a
  // machine-parseable form, deliberately distinct from the heading's collapsed rangeLabel; do not
  // migrate it onto lineRange (issue #231 r4).
  readonly startLine: number;
  readonly endLine: number;
  readonly side?: string;
  readonly severity: string;
  readonly confidence: string;
  readonly likelihood: string;
  readonly m: string;
  // Pre-split into blockquote-safe lines: the aside is a `>` blockquote, so an unprefixed line would
  // break out of it and spill a hidden nit's detail into the visible prose.
  readonly carried: readonly string[];
  // Replies naming this hidden nit's id (the aside's discussion slot — the suppressed aside is a
  // discussion surface like the strays').
  readonly discussion: readonly DiscussionLink[];
  readonly discussionTruncated?: number;
};

// HTML comments cannot nest, so a `-->` inside a carried field would close the block early and spill
// the rest into the visible prose. A zero-width space between the dashes and the `>` breaks the
// sequence while rendering invisibly, so a human reading the carried text sees it VERBATIM — the
// previous replacement mutated the author's own text to a visible hyphen (issue #217 review r7).
const commentSafe = (text: string): string =>
  text.replace(/--+(?=>)/g, (dashes) => `${dashes}\u200b`);

const sanitizeSuppressedNit = (
  f: Finding,
  discussion: readonly DiscussionLink[],
  discussionTruncated?: number,
): SuppressedNitView => ({
  title: escapeCodeBackticks(f.title),
  id: escapeCodeBackticks(f.id),
  ...(f.code_url !== undefined ? { codeUrl: linkSafeUrl(f.code_url) } : {}),
  path: commentSafe(escapeCodeBackticks(f.path)),
  startLine: f.start_line,
  endLine: f.end_line,
  ...(f.side !== undefined ? { side: f.side } : {}),
  severity: f.severity,
  confidence: formatConfidence(f.confidence),
  likelihood: formatConfidence(f.likelihood),
  m: formatConfidence(f.confidence * f.likelihood),
  carried: carriedLines(f),
  discussion,
  ...(discussionTruncated !== undefined ? { discussionTruncated } : {}),
});

// Each carried field is clipped. Every below-floor nit's full finding rides in the sticky body, and
// that body is the one GitHub rejects over 65536 chars — which post deliberately does not shed, so an
// oversized body 422s the round with the announce placeholder still up. Removing the ~32KB document
// bought far more room than this spends, but "far more room" is not a bound. The cap IS the
// conversation clip's (BODY_CLIP_CHARS, util.ts) — one constant so the two can't drift — and clipText
// marks what it cut so a reader is never silently shown a fragment.

const carriedLines = (f: Finding): readonly string[] =>
  [
    `description: ${clipText(f.description, BODY_CLIP_CHARS)}`,
    ...(f.recommendation !== undefined
      ? [`recommendation: ${clipText(f.recommendation, BODY_CLIP_CHARS)}`]
      : []),
    `reasoning: ${clipText(f.reasoning, BODY_CLIP_CHARS)}`,
    ...(f.patch !== undefined ? ["patch:", clipText(f.patch, BODY_CLIP_CHARS)] : []),
  ]
    .flatMap((block) => commentSafe(block).split("\n"))
    .map((line) => line.trimEnd());

// The same render-safety escaping as strays: pipes break tables, backticks break inline code spans.
// finding_ids render inside backticks too, so they get the same backtick escaping as paths.
const sanitizeSystemic = (
  s: SystemicProblem,
  discussion: readonly DiscussionLink[],
  discussionTruncated?: number,
): SystemicProblem & {
  readonly discussion: readonly DiscussionLink[];
  readonly discussionTruncated?: number;
} => ({
  ...s,
  title: escapePipes(s.title),
  discussion,
  ...(discussionTruncated !== undefined ? { discussionTruncated } : {}),
  ...(s.id !== undefined ? { id: escapeCodeBackticks(s.id) } : {}),
  ...(s.code_url !== undefined ? { code_url: linkSafeUrl(s.code_url) } : {}),
  ...(s.paths !== undefined ? { paths: s.paths.map(escapeCodeBackticks) } : {}),
  ...(s.finding_ids !== undefined ? { finding_ids: s.finding_ids.map(escapeCodeBackticks) } : {}),
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
  // Price a time-slotted model at the RUN's completion instant (issue #170) — stamped in the envelope
  // by adapt, so re-rendering the same envelope always picks the same slot; input.pricedAt is only the
  // fallback for a pre-#170 envelope that carries no generated_at.
  const pricedAt = parseInstant(input.envelope?.generated_at) ?? input.pricedAt;
  const costReport = input.envelope
    ? computeCost(input.envelope.models, input.prices, pricedAt)
    : null;
  const pricesProvided = input.pricesProvided ?? true;
  const route = input.route ?? input.envelope?.route ?? null;
  const effort = input.effort ?? input.envelope?.effort ?? null;
  const modelNames = input.envelope ? input.envelope.models.map((m) => m.model).join(", ") : "";
  const severityCounts = input.severityCounts ?? computeSeverityCounts(input.findings.findings);
  // The pipeline-stamped convergence field (issue #174) is the source for the trajectory and the badge.
  // `input.rounds` is a fallback only for callers that supply a legacy trajectory directly (tests, or a
  // standalone render of a doc without convergence); its entries carry no score and render "—". Every
  // production sticky carries convergence — in the compact marker beside the link (issue #217) — so
  // the fallback never fires there.
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
  // completed and neither the badge nor the stop signal may appear (the README's omission
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

  // The discussion links a below-floor nit's aside slot renders — keyed by the RAW id like every
  // other discussion lookup.
  const discussionLinksFor = (id: string): readonly DiscussionLink[] =>
    input.discussionByFinding !== undefined &&
    Object.prototype.hasOwnProperty.call(input.discussionByFinding, id)
      ? (input.discussionByFinding[id] ?? [])
      : [];
  const discussionTruncatedFor = (id: string): number | undefined =>
    input.discussionTruncated !== undefined &&
    Object.prototype.hasOwnProperty.call(input.discussionTruncated, id)
      ? input.discussionTruncated[id]
      : undefined;

  const suppressedBudget = budgetBySize(
    (input.suppressedNits ?? []).map((f) =>
      sanitizeSuppressedNit(f, discussionLinksFor(f.id), discussionTruncatedFor(f.id)),
    ),
    CARRIED_TOTAL_CHARS,
    (n) =>
      // The fixed overhead covers the summary line's structure; the reviewer-controlled variable
      // parts are budgeted at their true RENDERED size — the title, the path TWICE (summary +
      // location line), the code/code_url the summary line renders, each carried line's `> `
      // blockquote prefix (length + 3: prefix + newline), the location line's line numbers and
      // side label, and the discussion slot's link list.
      n.carried.reduce((sum, line) => sum + line.length + 3, 0) +
      SUPPRESSED_NIT_BLOCK_OVERHEAD +
      n.title.length +
      n.path.length * 2 +
      // The id renders with its two wrapper backticks; the code_url adds the [](...) link form.
      n.id.length * 2 +
      2 +
      (n.codeUrl !== undefined ? n.codeUrl.length + 4 : 0) +
      String(n.startLine).length * 2 +
      String(n.endLine).length +
      (n.side !== undefined ? n.side.length + 2 : 0) +
      discussionLinksCost(n.discussion),
    () => null,
  );

  // The permalink identity is ONE optional: repo + reviewedSha only mean something together, and a
  // half-supplied OR EMPTY pair must not render malformed `//blob/` links — precomputed once per
  // render rather than rebuilt per stray (issue #231 r1 + r3).
  const permalinkBase =
    input.repo !== undefined &&
    input.repo !== "" &&
    input.reviewedSha !== undefined &&
    input.reviewedSha !== ""
      ? `https://github.com/${input.repo}/blob/${input.reviewedSha}/`
      : undefined;
  const unanchored = new Set(input.unanchoredStrays ?? []);

  const strayViews = (input.strays ?? []).map((f) =>
    sanitizeFinding(
      f,
      input.answeredNotes,
      input.discussionByFinding,
      permalinkBase,
      unanchored,
      input.discussionTruncated,
    ),
  );
  // The discussion aside is additive to the one body post deliberately never sheds: the orphaned
  // section and the per-finding asides draw from ONE budget, whole asides dropped past it, the cut
  // named in the template, never silent. An aside whose finding has no replies costs nothing and
  // is never counted as dropped — only a thread that existed can be "not listed".
  const orphanedBudget = budgetBySize(
    Object.entries(input.orphanedDiscussion ?? {}),
    DISCUSSION_TOTAL_CHARS,
    ([token, links]) => token.length + ORPHANED_ENTRY_OVERHEAD + discussionLinksCost(links),
    () => null,
  );
  const discussionBudget = budgetBySize(
    strayViews,
    DISCUSSION_TOTAL_CHARS - orphanedBudget.used,
    (view) =>
      view.discussion.length > 0
        ? DISCUSSION_BLOCK_OVERHEAD + discussionLinksCost(view.discussion)
        : 0,
    (view) => ({ ...view, discussion: [] }),
  );
  // The systemic asides draw from the SAME pool, third in line: orphaned (permanent cut) first,
  // then the strays' asides, then the systemics'.
  const systemicBudget = budgetBySize(
    (input.findings.systemic_problems ?? []).map((s) =>
      sanitizeSystemic(
        s,
        s.id !== undefined ? discussionLinksFor(s.id) : [],
        s.id !== undefined ? discussionTruncatedFor(s.id) : undefined,
      ),
    ),
    DISCUSSION_TOTAL_CHARS - orphanedBudget.used - discussionBudget.used,
    (s) =>
      s.discussion.length > 0 ? DISCUSSION_BLOCK_OVERHEAD + discussionLinksCost(s.discussion) : 0,
    (s) => ({ ...s, discussion: [] }),
  );

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
    strays: discussionBudget.kept,
    orphanedDiscussion: Object.fromEntries(
      orphanedBudget.kept.map(([token, links]) => [escapeCodeBackticks(token), links]),
    ),
    orphanedTruncated:
      input.orphanedTruncated !== undefined
        ? Object.fromEntries(
            Object.entries(input.orphanedTruncated).map(([token, n]) => [
              escapeCodeBackticks(token),
              n,
            ]),
          )
        : undefined,
    orphanedUnresolvable: input.orphanedUnresolvable === true,
    discussionDropped: discussionBudget.droppedItems.length + systemicBudget.droppedItems.length,
    discussionDroppedIds: discussionBudget.droppedItems.map((v) => escapeCodeBackticks(v.idKey)),
    discussionDroppedSystemicIds: systemicBudget.droppedItems.flatMap((s) =>
      s.id !== undefined ? [s.id] : [],
    ),
    discussionCap: PER_FINDING_LINKS,
    orphanedTotal: input.orphanedTotal ?? 0,
    suppressedNits: suppressedBudget.kept,
    carriedDroppedNits: suppressedBudget.droppedItems.length,
    nitVisibilityFloor: input.nitVisibilityFloor ?? DEFAULT_NIT_VISIBILITY_FLOOR,
    systemic: systemicBudget.kept,
    unanchoredCount: input.unanchoredCount ?? 0,
    inlineDisposition: input.inlineDisposition ?? null,
    unverifiedNoLogs: input.unverifiedNoLogs === true,
    runUrl: input.runUrl ?? null,
    jsonUrl: input.jsonUrl ?? null,
    // The marker names the findings artifact, so the convergence no longer rides inside the comment —
    // it needs its own compact marker beside the link or a trajectory would require a fetch to read
    // (issue #217). post precomputes both together in findingsBlob; the standalone `render` command
    // builds the same pair here, so neither path can emit a link with the convergence missing.
    findingsPointer:
      input.findingsPointer ?? findingsMarkerPair(input.jsonUrl, input.findings.convergence),
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
