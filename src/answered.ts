// The "already answered" state (issue #151): the deterministic registry of prior inline findings
// whose threads a human reply answered, plus the two rules built on it — the re-review seed surfaces
// the registry so the next-round agent does not re-raise, and post() treats a VERBATIM re-raise as
// closed: identical match (code or title), identical claim TEXT (title + description + reasoning),
// identical severity, and identical location/fix (path + patch — the line is deliberately excluded,
// positional drift is not evidence), i.e. no new evidence by definition. The drop is removed from
// the surfaced review and NAMED in the sticky; a re-raise with any changed component is kept and
// annotated with the prior answer's link.

import * as t from "io-ts";
import { escapeCodeBackticks, parseFindingsMarker } from "./surface.js";
import { parseJsonl } from "./transcript.js";
import type { GhApi } from "./gh.js";
import type { Finding, Severity } from "./schema.js";
import { clipText, errMsg } from "./util.js";

// One flat review comment as REST `pulls/{n}/comments` returns it — enough to rebuild reply threads
// from `in_reply_to_id` chains (a reply to a reply included) and to decode the bot comment's embedded
// per-finding marker.
export interface ThreadComment {
  readonly id: number;
  readonly in_reply_to_id: number | null;
  readonly user_login: string;
  // "User" | "Bot" — lets the registry exclude replies from OTHER bots (a CI/dependabot comment
  // is not a human answer), not just this pipeline's own bot login.
  readonly user_type: string | null;
  readonly body: string | null;
  readonly html_url: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly created_at: string | null;
}

// The jq projection gather and post share. It emits BOTH the flat `user_login`/`user_type` the
// answered-registry codec reads AND the nested `user: {login}` (+ author_association) the
// conversation codec reads — one fetch feeds two consumers, and neither may be silently starved by
// a field rename (issue #151 review r1: the original single-shape projection emptied the
// conversation's review_comments in production while the mocks, which bypass jq, kept the tests
// green).
export const THREAD_COMMENT_JQ =
  ".[] | {id, in_reply_to_id, user: {login: .user.login}, user_login: .user.login, user_type: .user.type, body, html_url, path, line, created_at, author_association}";

export const ThreadCommentCodec = t.type({
  id: t.number,
  in_reply_to_id: t.union([t.number, t.null]),
  user_login: t.string,
  user_type: t.union([t.string, t.null]),
  body: t.union([t.string, t.null]),
  html_url: t.string,
  path: t.union([t.string, t.null]),
  line: t.union([t.number, t.null]),
  created_at: t.union([t.string, t.null]),
});

// The registry entry for one answered finding: the finding's identifying fields (the verbatim-match
// targets), the thread link, and the first human reply's link + a clipped excerpt for the seed.
export interface AnsweredEntry {
  // "" when the answered finding carried no code — matching then falls back to title equality
  // between two codeless findings (the issue's "code (or title)" rule).
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly reasoning: string;
  // The answered finding's severity — a re-raise ESCALATED in severity is not verbatim (the claim
  // weight changed), so it is kept and annotated rather than dropped (issue #151 review r1).
  readonly severity: Severity;
  // The answered finding's path and proposed patch — a re-raise RELOCATED to another file, or one
  // whose proposed fix changed, carries something new and is kept, not dropped (issue #151 review
  // r3). patch is null when the answered finding carried none. The LINE is deliberately NOT part of
  // the predicate: positional drift (a rebase moving the same claim) is not evidence, while a
  // genuinely new instance changes the claim text.
  readonly path: string;
  readonly patch: string | null;
  // The REPLY's timestamp — read for the dedup: "most recent answer wins" must key on the ANSWER
  // time, not the root (review-posting) order (issue #151 review r4).
  readonly repliedAt: string | null;
  readonly threadUrl: string;
  readonly replyUrl: string;
  readonly replyAuthor: string;
  readonly replyExcerpt: string;
}

// The staged-registry codec (what gather writes to answered.json and seed-draft reads back) — the
// SNAKE_CASE wire shape, distinct from the camelCase in-process AnsweredEntry; rows that fail decode
// are dropped like every other untrusted artifact, never fatal.
export const AnsweredEntryCodec = t.type({
  code: t.string,
  title: t.string,
  description: t.string,
  reasoning: t.string,
  severity: t.union([
    t.literal("critical"),
    t.literal("major"),
    t.literal("minor"),
    t.literal("nit"),
  ]),
  path: t.string,
  patch: t.union([t.string, t.null]),
  replied_at: t.union([t.string, t.null]),
  thread_url: t.string,
  reply_url: t.string,
  reply_author: t.string,
  reply_excerpt: t.string,
});

export type StagedAnsweredEntry = t.TypeOf<typeof AnsweredEntryCodec>;

export const encodeAnsweredEntry = (e: AnsweredEntry): StagedAnsweredEntry => ({
  code: e.code,
  title: e.title,
  description: e.description,
  reasoning: e.reasoning,
  severity: e.severity,
  path: e.path,
  patch: e.patch,
  replied_at: e.repliedAt,
  thread_url: e.threadUrl,
  reply_url: e.replyUrl,
  reply_author: e.replyAuthor,
  reply_excerpt: e.replyExcerpt,
});

export const decodeAnsweredEntry = (raw: unknown): StagedAnsweredEntry | null => {
  const decoded = AnsweredEntryCodec.decode(raw);
  return decoded._tag === "Right" ? decoded.right : null;
};

// A reply is "answered" when a HUMAN commented on the thread: neither this pipeline's bot (matched
// by login) nor any other bot account (matched by the REST user.type, so a CI/dependabot comment
// can't masquerade as an answer — issue #151 review r1). A MISSING type (null — an unexpected API
// shape) fails closed to "not human": an uncertain answer must not cause a finding to be dropped
// (issue #151 review r2).
const isHuman = (login: string, type: string | null, botLogin: string): boolean =>
  login !== botLogin && type === "User";

const EXCERPT_LIMIT = 400;

// OUTDATED/minimized threads are deliberately NOT excluded: the pipeline minimizes superseded
// bot comments at the end of every post, so excluding them would erase the very persistence the
// feature exists for — an answer from round 1 must still close a verbatim re-raise in round 8
// (issue #151 review r1 considered and rejected the stale-thread scope).

// The pure thread→registry construction. A thread is anchored on the bot's comment (by login); the
// root's embedded per-finding marker names the finding. Replies are every non-bot comment whose
// in_reply_to chain reaches that root. The FIRST human reply per thread is recorded; when the same
// code was answered in several threads, the most recent thread wins. Tolerant: an undecodable bot
// comment (no marker, or a marker that fell to the link form) contributes nothing.
export const answeredRegistryFrom = (
  comments: readonly ThreadComment[],
  botLogin: string,
): readonly AnsweredEntry[] => {
  // Order-independent: the REST order (ascending creation) is not a contract, so "first human
  // reply" and "most recent answer wins" sort explicitly by (created_at, id) before processing
  // (issue #151 review r2). Missing created_at sorts last.
  const ordered = [...comments].sort(
    (a, b) =>
      (a.created_at ?? "￿").localeCompare(b.created_at ?? "￿") ||
      (a.id > b.id ? 1 : a.id < b.id ? -1 : 0),
  );
  const byId = new Map<number, ThreadComment>();
  for (const c of ordered) byId.set(c.id, c);

  // The root of a comment's chain (walk in_reply_to_id up, cycle-safe); null when the chain never
  // reaches a top-level comment within the fetched set.
  const rootOf = (c: ThreadComment): ThreadComment | null => {
    let current = c;
    const seen = new Set<number>();
    while (current.in_reply_to_id !== null && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.in_reply_to_id);
      if (parent === undefined) return null;
      current = parent;
    }
    return current.in_reply_to_id === null ? current : null;
  };

  // The answered finding of a bot-rooted thread, from the root comment's embedded per-finding marker.
  const findingOf = (
    root: ThreadComment,
  ): {
    code: string;
    title: string;
    description: string;
    reasoning: string;
    severity: Severity;
    path: string;
    patch: string | null;
  } | null => {
    const decoded = parseFindingsMarker(root.body ?? "");
    const doc =
      typeof decoded === "object" && decoded !== null
        ? (decoded as { findings?: unknown }).findings
        : undefined;
    const first = Array.isArray(doc) ? (doc[0] as Record<string, unknown> | undefined) : undefined;
    if (first === undefined) return null;
    const title = first["title"];
    const description = first["description"];
    const reasoning = first["reasoning"];
    const code = first["code"];
    const severity = first["severity"];
    const path = first["path"];
    const patch = first["patch"];
    return typeof title === "string" &&
      typeof description === "string" &&
      typeof reasoning === "string" &&
      typeof path === "string" &&
      (severity === "critical" ||
        severity === "major" ||
        severity === "minor" ||
        severity === "nit")
      ? {
          code: typeof code === "string" ? code : "",
          title,
          description,
          reasoning,
          severity,
          path,
          patch: typeof patch === "string" ? patch : null,
        }
      : null;
  };

  // Group every comment under its root id; the root's own id keys the group. Iterating the SORTED
  // array feeds both selections below — the first-human-reply find() and the last-wins dedup both
  // read group/map insertion order, so the sort must drive that order (issue #151 review r3: the
  // original fix sorted into `byId` only, leaving the selection loops on the raw API order).
  const threads = new Map<number, ThreadComment[]>();
  for (const c of ordered) {
    const root = rootOf(c);
    if (root === null) continue;
    const group = threads.get(root.id);
    if (group === undefined) threads.set(root.id, [c]);
    else group.push(c);
  }

  // One entry per answered bot-rooted thread: the thread must be anchored on the BOT's comment;
  // the answer is the first HUMAN comment in it.
  const entries: AnsweredEntry[] = [];
  for (const [rootId, group] of threads) {
    const root = byId.get(rootId);
    if (root === undefined || root.user_login !== botLogin) continue;
    const finding = findingOf(root);
    if (finding === null) continue;
    const reply = group.find(
      (c) => c.id !== root.id && isHuman(c.user_login, c.user_type, botLogin),
    );
    if (reply === undefined) continue;
    entries.push({
      ...finding,
      repliedAt: reply.created_at,
      threadUrl: root.html_url,
      replyUrl: reply.html_url,
      replyAuthor: reply.user_login,
      replyExcerpt: clipText(reply.body ?? "", EXCERPT_LIMIT),
    });
  }
  // Dedup by the shared note key, keeping the entry with the MOST RECENT ANSWER — keyed on the
  // REPLY time, never the root (review-posting) order: an older thread answered later must win over
  // a newer thread answered earlier (issue #151 review r4).
  const byKey = new Map<string, AnsweredEntry>();
  for (const entry of entries) {
    const key = answeredNoteKey(entry);
    const prior = byKey.get(key);
    if (prior === undefined || (entry.repliedAt ?? "") >= (prior.repliedAt ?? "")) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
};

// The "code (or title)" match: codes equal when the finding carries one; two codeless findings match
// on equal titles. A code-bearing finding never matches a codeless answered entry (and vice versa).
const matches = (f: Finding, e: AnsweredEntry): boolean =>
  f.code !== undefined && f.code !== "" ? e.code === f.code : e.code === "" && e.title === f.title;

// The ONE note-key contract: a finding's annotation key is its code when it carries one, else
// "title:<title>" — written once here, consumed by the registry builder, applyAnswered, and both
// renderers, so the key can never drift between the writer and the lookups (issue #151 review r2).
export const answeredNoteKey = (f: { code?: string; title: string }): string =>
  f.code !== undefined && f.code !== "" ? f.code : `title:${f.title}`;

// The per-finding "re-raised; prior answer at <link>" annotation for a kept (changed-evidence)
// re-raise; the pipeline cannot judge whether the reply dismissed or acknowledged the finding, so the
// annotation links it and demands the new evidence be named.
export const answeredNote = (e: AnsweredEntry): string =>
  `Re-raised; prior answer at ${e.replyUrl} by ${e.replyAuthor} — cite the new evidence that invalidates it.`;

export interface AnsweredFilter {
  readonly findings: readonly Finding[];
  // code → note for KEPT re-raises with changed evidence; rendered under each such finding.
  readonly reRaisedNotes: Readonly<Record<string, string>>;
  // The entries whose findings were dropped: verbatim re-raises of an answered finding, named in the
  // sticky rather than silently vanishing. DEDUPED by key — two findings sharing one dropped code (a
  // code repeated within a round) list the answer once, never double-counted (issue #151 review r2).
  readonly verbatimReRaised: readonly AnsweredEntry[];
}

// The deterministic backstop beneath the seed guidance: an answered finding re-raised VERBATIM
// (identical title, description, and reasoning — no new evidence by definition) is treated as closed
// and dropped from this review, so the round's counts and stop signal reflect the dismissal. The
// claim TEXT is the evidence: a change to any of title/description/reasoning, or to the severity,
// means the re-raise carries something new and MUST be kept + annotated (issue #151 review r2 — the
// SPEC's "no new evidence" criterion, not just a title+reasoning byte-match). A critical is never
// dropped — the pipeline must not suppress a critical from the surfaced review.
export const applyAnswered = (
  findings: readonly Finding[],
  registry: readonly AnsweredEntry[],
): AnsweredFilter => {
  const kept: Finding[] = [];
  // Built via Object.fromEntries (CreateDataProperty): a reviewer-supplied code like "__proto__"
  // must become an OWN data key, never a prototype write that silently no-ops the annotation (the
  // same invariant the codebase's other code-keyed maps hold — issue #151 review r1).
  const noteEntries: [string, string][] = [];
  const droppedByKey = new Map<string, AnsweredEntry>();
  for (const f of findings) {
    const entry = registry.find((e) => matches(f, e));
    if (entry === undefined) {
      kept.push(f);
      continue;
    }
    // The full claim: text (title/description/reasoning), weight (severity), AND location/fix
    // (path, patch) — a re-raise relocated to another file or proposing a different fix carries
    // something new. The line is deliberately excluded: positional drift (a rebase moving the same
    // claim) is not evidence (issue #151 review r3). patch is normalized (undefined → null) so an
    // absent patch on both sides compares equal.
    const verbatim =
      f.title === entry.title &&
      f.description === entry.description &&
      f.reasoning === entry.reasoning &&
      f.severity === entry.severity &&
      f.path === entry.path &&
      (f.patch ?? null) === entry.patch;
    if (verbatim && f.severity !== "critical") {
      droppedByKey.set(answeredNoteKey(f), entry);
    } else {
      kept.push(f);
      noteEntries.push([answeredNoteKey(f), answeredNote(entry)]);
    }
  }
  return {
    findings: kept,
    reRaisedNotes: Object.fromEntries(noteEntries),
    verbatimReRaised: [...droppedByKey.values()],
  };
};

// The sticky note naming what was dropped — the suppression is never silent (SPEC §3.3 truthful).
export const answeredReRaiseNote = (entries: readonly AnsweredEntry[]): string => {
  if (entries.length === 0) return "";
  const label = (e: AnsweredEntry): string =>
    e.code !== "" ? `\`${escapeCodeBackticks(e.code)}\`` : `“${escapeCodeBackticks(e.title)}”`;
  const lines = entries.map(
    (e) => `> - ${label(e)} — [prior answer](${e.replyUrl}) by ${e.replyAuthor}`,
  );
  return [
    `> ↩️ **${String(entries.length)} finding(s) re-raised without new evidence — treated as answered** (each has a human reply on its prior inline thread):`,
    ...lines,
  ].join("\n");
};

// Best-effort fetch of the full review-comment set (bot + human, paginated at the API's max page
// size so a long-lived PR's history costs the fewest requests — the FULL history is intentional,
// persistence is the feature: an answer from round 1 must still close a round-8 verbatim re-raise);
// null on any transport error so a degraded channel degrades to an empty registry — never a failed
// post.
export const fetchThreadComments = async (
  ghApi: GhApi,
  repo: string,
  prNumber: number,
): Promise<readonly ThreadComment[] | null> => {
  try {
    const rows = parseJsonl(
      await ghApi([
        `repos/${repo}/pulls/${String(prNumber)}/comments`,
        "-f",
        "per_page=100",
        "--paginate",
        "--jq",
        THREAD_COMMENT_JQ,
      ]),
    );
    return rows.flatMap((row) => {
      const decoded = ThreadCommentCodec.decode(row);
      return decoded._tag === "Right" ? [decoded.right] : [];
    });
  } catch (err) {
    process.stderr.write(
      `Warning: could not fetch review threads to detect answered findings (${errMsg(err)}) — no answered-finding state for this post\n`,
    );
    return null;
  }
};
