import * as t from "io-ts";
import { ID_SHAPE_RE, strictExact } from "./schema.js";
import { clipText } from "./util.js";

export const RESPONSE_REASON_CLIP_CHARS = 300;
export const RESPONSES_PER_CHANNEL = 25;

const DispositionCodec = t.keyof({ fixed: null, refuted: null, dismissed: null });
const ChannelCodec = t.keyof({ comment: null, commit: null });
type Disposition = t.TypeOf<typeof DispositionCodec>;

// The response vocabulary, for every surface that teaches it.
export const DISPOSITIONS = Object.keys(DispositionCodec.keys) as readonly Disposition[];

// The roles whose answers come from the maintainers, as the reviewer's note names them.
export const MAINTAINER_ASSOCIATIONS: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];

const CLOSING_DISPOSITIONS: ReadonlySet<Disposition> = new Set(["refuted", "dismissed"]);

export const RESPONSE_FORM = `Review-Response: <id> ${DISPOSITIONS.join("|")} — <reason>`;

const ResponseShape = t.type({
  id: t.string,
  disposition: DispositionCodec,
  reason: t.string,
  channel: ChannelCodec,
  source_url: t.string,
  author: t.union([t.string, t.null]),
  author_association: t.union([t.string, t.null]),
  created_at: t.union([t.string, t.null]),
});
export const ResponseCodec = strictExact("Response", ResponseShape, [ResponseShape]);

const UnmatchedResponseShape = t.type({
  id: t.string,
  channel: ChannelCodec,
  source_url: t.string,
});
export const UnmatchedResponseCodec = strictExact("UnmatchedResponse", UnmatchedResponseShape, [
  UnmatchedResponseShape,
]);

const ResponsesFileShape = t.type({
  responses: t.array(ResponseCodec),
  unmatched: t.array(UnmatchedResponseCodec),
});
export const ResponsesFileCodec = strictExact("ResponsesFile", ResponsesFileShape, [
  ResponsesFileShape,
]);

export type Response = t.TypeOf<typeof ResponseCodec>;
export type ResponsesFile = t.TypeOf<typeof ResponsesFileCodec>;

interface ParsedLine {
  readonly id: string;
  readonly disposition: Disposition;
  readonly reason: string;
}

// `Review-Response: <id> <disposition> — <reason>`, the key case-insensitive like a git trailer.
// Indented at most three spaces, as a markdown paragraph is: a `>` quote, an inline-code copy, or a
// four-space code line is never a response. A verb still followed by the taught `|` alternation is a
// half-filled copy of the form, not a choice.
const RESPONSE_LINE_RE =
  /^ {0,3}review-response:\s*(\S+)\s+([A-Za-z]+)(?![A-Za-z]|\s*\|)[\s—–:-]*(.*)$/i;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const LINE_BREAK_RE = /\r\n?|\n|\u2028|\u2029/;

// The lines outside fenced code, by CommonMark's rule: a fence opens on three or more backticks or
// tildes indented at most three spaces (a backtick fence's info string holds no backtick), and only a
// line of the same character at least as long closes it; an unclosed fence runs to the end. A fenced
// copy quotes the grammar rather than using it.
export const unfencedLines = (text: string): readonly string[] =>
  text.split(LINE_BREAK_RE).reduce<{
    readonly fence: string | null;
    readonly lines: string[];
  }>(
    (state, line) => {
      const marker = FENCE_OPEN_RE.exec(line)?.[1];
      if (state.fence === null) {
        if (marker !== undefined) return { fence: marker, lines: state.lines };
        state.lines.push(line);
        return state;
      }
      const closes =
        marker !== undefined &&
        marker[0] === state.fence[0] &&
        marker.length >= state.fence.length &&
        line.trim() === marker;
      return closes ? { fence: null, lines: state.lines } : state;
    },
    { fence: null, lines: [] },
  ).lines;

// The id token as written, unwrapped from the backticks or quotes the sticky displays it in and from
// the prose punctuation that may follow it.
const unwrapId = (token: string): string => token.replace(/^[`"']+|[`"'.,:;]+$/g, "");

// Any token parses as an id: whether it has an id's shape is the harvest's rule, not the grammar's.
export const parseResponseLines = (text: string): readonly ParsedLine[] =>
  unfencedLines(text).flatMap((line) => {
    const match = RESPONSE_LINE_RE.exec(line);
    const id = unwrapId(match?.[1] ?? "");
    const disposition = match?.[2]?.toLowerCase();
    return id !== "" && DispositionCodec.is(disposition)
      ? [
          {
            id,
            disposition,
            reason: clipText((match?.[3] ?? "").trim(), RESPONSE_REASON_CLIP_CHARS),
          },
        ]
      : [];
  });

// A comment answers only when a HUMAN wrote it: neither this pipeline's bot (matched by login) nor
// any other bot account (matched by the REST user.type, so a CI/dependabot comment can't masquerade
// as an answer). A MISSING type (null — an unexpected API shape) fails closed to "not human".
export const isHuman = (login: string, type: string | null, botLogin: string): boolean =>
  login !== botLogin && type === "User";

// Where answers come from: the PR's conversation comments and its commits.
export interface AnswerSources {
  readonly repo: string;
  readonly prNumber: number;
  readonly botLogin: string;
  readonly commits: readonly {
    readonly sha: string;
    readonly message: string;
    readonly author: string | null;
    readonly date?: string | null;
  }[];
  readonly comments: readonly {
    readonly id: number;
    readonly body: string | null;
    readonly user: { readonly login: string; readonly type?: string | null };
    readonly created_at?: string | null;
    readonly author_association?: string | null;
  }[];
}

export interface HarvestInput extends AnswerSources {
  readonly priorIds: ReadonlySet<string>;
}

export interface Harvest {
  readonly file: ResponsesFile;
  // Response lines past a channel's cap: named by the caller, never cut silently.
  readonly dropped: number;
}

// Newest first, with the comment id breaking a same-second tie (GitHub timestamps are second-grained).
const newestFirst = (
  a: AnswerSources["comments"][number],
  b: AnswerSources["comments"][number],
): number => {
  const [left, right] = [a.created_at ?? "", b.created_at ?? ""];
  return left < right ? 1 : left > right ? -1 : b.id - a.id;
};

// Every answer on the PR, newest first per channel. Only a human account answers: another bot's
// comment never poses as the implementer.
export const answersFrom = (
  input: AnswerSources,
): { readonly comments: readonly Response[]; readonly commits: readonly Response[] } => {
  const comments: readonly Response[] = [...input.comments]
    .filter((comment) => isHuman(comment.user.login, comment.user.type ?? null, input.botLogin))
    .sort(newestFirst)
    .flatMap((comment) =>
      parseResponseLines(comment.body ?? "").map((line) => ({
        ...line,
        channel: "comment" as const,
        source_url: `https://github.com/${input.repo}/pull/${String(input.prNumber)}#issuecomment-${String(comment.id)}`,
        author: comment.user.login,
        author_association: comment.author_association ?? null,
        created_at: comment.created_at ?? null,
      })),
    );
  const commits: readonly Response[] = [...input.commits].reverse().flatMap((commit) =>
    parseResponseLines(commit.message).map((line) => ({
      ...line,
      channel: "commit" as const,
      source_url: `https://github.com/${input.repo}/commit/${commit.sha}`,
      author: commit.author,
      author_association: null,
      created_at: commit.date ?? null,
    })),
  );
  return { comments, commits };
};

// The answers staged for the reviewer, newest first per channel so a long PR never pushes its recent
// answers out of the cap. An answer naming an id the prior round reported is a response; any other
// id-shaped one is echoed as unmatched rather than silently dropped.
export const harvestResponses = (input: HarvestInput): Harvest => {
  const { comments: fromComments, commits: fromCommits } = answersFrom(input);
  const matched = (response: Response): boolean => input.priorIds.has(response.id);
  const echoed = (response: Response): boolean =>
    !matched(response) && ID_SHAPE_RE.test(response.id);
  const groups = [fromComments, fromCommits].flatMap((channel) => [
    channel.filter(matched),
    channel.filter(echoed),
  ]);
  const [comments, commentEchoes, commits, commitEchoes] = groups.map((group) =>
    group.slice(0, RESPONSES_PER_CHANNEL),
  );
  return {
    file: {
      responses: [...(comments ?? []), ...(commits ?? [])],
      unmatched: [...(commentEchoes ?? []), ...(commitEchoes ?? [])].map(
        ({ id, channel, source_url }) => ({ id, channel, source_url }),
      ),
    },
    dropped: groups.reduce(
      (total, group) => total + Math.max(0, group.length - RESPONSES_PER_CHANNEL),
      0,
    ),
  };
};

// Whether an answer comes from the maintainers: a comment by its author's role on the base repo, a
// commit by the push access a head branch IN the base repo implies — the caller reads that from the
// PR itself, so a fork's commit, or one whose head repo could not be read, never does.
export const isTrustedResponse = (response: Response, headInBaseRepo: boolean): boolean => {
  switch (response.channel) {
    case "comment":
      return MAINTAINER_ASSOCIATIONS.includes(response.author_association ?? "");
    case "commit":
      return headInBaseRepo;
  }
};

const answeredInstant = (response: Response): number =>
  response.created_at === null ? Number.NaN : Date.parse(response.created_at);

// The answers that close their ids: per id, the newest trusted answer, when it refutes or dismisses
// the finding. A `fixed` is a claim the reviewer verifies, never a closure, and a newer one reopens
// the id; an answer whose time cannot be read cannot be ordered, so its id never closes, and neither
// does a same-instant tie with a `fixed`.
export const closingResponses = (
  responses: readonly Response[],
  isTrusted: (response: Response) => boolean,
): readonly Response[] => {
  const byId = responses.filter(isTrusted).reduce((groups, response) => {
    const timed = { response, at: answeredInstant(response) };
    groups.set(response.id, [...(groups.get(response.id) ?? []), timed]);
    return groups;
  }, new Map<string, readonly { readonly response: Response; readonly at: number }[]>());
  return [...byId.values()].flatMap((answers) => {
    if (answers.some(({ at }) => Number.isNaN(at))) return [];
    const latest = Math.max(...answers.map(({ at }) => at));
    const newest = answers.filter(({ at }) => at === latest).map(({ response }) => response);
    return newest.every((response) => CLOSING_DISPOSITIONS.has(response.disposition))
      ? [...newest].sort((a, b) => (a.source_url < b.source_url ? -1 : 1)).slice(0, 1)
      : [];
  });
};
