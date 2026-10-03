import * as t from "io-ts";
import { ID_SHAPE_RE } from "./schema.js";
import { clipText } from "./util.js";

export const RESPONSE_REASON_CLIP_CHARS = 300;
export const RESPONSES_PER_CHANNEL = 25;

const DispositionCodec = t.keyof({ fixed: null, refuted: null, dismissed: null });
const ChannelCodec = t.keyof({ comment: null, commit: null });

export const ResponseCodec = t.exact(
  t.type({
    id: t.string,
    disposition: DispositionCodec,
    reason: t.string,
    channel: ChannelCodec,
    source_url: t.string,
    author: t.union([t.string, t.null]),
    author_association: t.union([t.string, t.null]),
    created_at: t.union([t.string, t.null]),
  }),
);

export const UnmatchedResponseCodec = t.exact(
  t.type({ id: t.string, channel: ChannelCodec, source_url: t.string }),
);

export const ResponsesFileCodec = t.exact(
  t.type({ responses: t.array(ResponseCodec), unmatched: t.array(UnmatchedResponseCodec) }),
);

export type Response = t.TypeOf<typeof ResponseCodec>;
export type ResponsesFile = t.TypeOf<typeof ResponsesFileCodec>;
type Disposition = t.TypeOf<typeof DispositionCodec>;

interface ParsedLine {
  readonly id: string;
  readonly disposition: Disposition;
  readonly reason: string;
}

// `Review-Response: <id> <disposition> — <reason>`, the key case-insensitive like a git trailer.
// Anchored at the line start, so a quoted (`>`) or inline-code copy of a response is never one.
const RESPONSE_LINE_RE = /^\s*review-response:\s*(\S+)\s+([A-Za-z]+)[\s—–:-]*(.*)$/i;
const FENCE_RE = /^\s*(?:```|~~~)/;

// A fenced code block quotes text rather than saying it: explaining the grammar is not a response.
const unfencedLines = (text: string): readonly string[] =>
  text
    .split(/\r?\n/)
    .reduce<{ readonly fenced: boolean; readonly lines: readonly string[] }>(
      (acc, line) =>
        FENCE_RE.test(line)
          ? { fenced: !acc.fenced, lines: acc.lines }
          : acc.fenced
            ? acc
            : { fenced: false, lines: [...acc.lines, line] },
      { fenced: false, lines: [] },
    ).lines;

export const parseResponseLines = (text: string): readonly ParsedLine[] =>
  unfencedLines(text).flatMap((line) => {
    const match = RESPONSE_LINE_RE.exec(line);
    const id = match?.[1];
    const disposition = match?.[2]?.toLowerCase();
    return id !== undefined && ID_SHAPE_RE.test(id) && DispositionCodec.is(disposition)
      ? [
          {
            id,
            disposition,
            reason: clipText((match?.[3] ?? "").trim(), RESPONSE_REASON_CLIP_CHARS),
          },
        ]
      : [];
  });

export interface HarvestInput {
  readonly repo: string;
  readonly prNumber: number;
  readonly botLogin: string;
  readonly priorIds: ReadonlySet<string>;
  readonly commits: readonly {
    readonly sha: string;
    readonly message: string;
    readonly author: string | null;
  }[];
  readonly comments: readonly {
    readonly id: number;
    readonly body: string | null;
    readonly user: { readonly login: string };
    readonly created_at?: string | null;
    readonly author_association?: string | null;
  }[];
}

// Every response line on the PR, newest first per channel, so a long PR never pushes its recent
// answers out of the cap. A response is kept only for an id the prior round reported; any other
// id-shaped line is echoed as unmatched rather than silently dropped.
export const harvestResponses = (input: HarvestInput): ResponsesFile => {
  const fromComments: readonly Response[] = [...input.comments]
    .filter((comment) => comment.user.login !== input.botLogin)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
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
  const fromCommits: readonly Response[] = [...input.commits].reverse().flatMap((commit) =>
    parseResponseLines(commit.message).map((line) => ({
      ...line,
      channel: "commit" as const,
      source_url: `https://github.com/${input.repo}/commit/${commit.sha}`,
      author: commit.author,
      author_association: null,
      created_at: null,
    })),
  );
  const capped = (
    responses: readonly Response[],
    keep: (response: Response) => boolean,
  ): readonly Response[] => responses.filter(keep).slice(0, RESPONSES_PER_CHANNEL);
  const matched = (response: Response): boolean => input.priorIds.has(response.id);
  return {
    responses: [...capped(fromComments, matched), ...capped(fromCommits, matched)],
    unmatched: [
      ...capped(fromComments, (response) => !matched(response)),
      ...capped(fromCommits, (response) => !matched(response)),
    ].map(({ id, channel, source_url }) => ({ id, channel, source_url })),
  };
};
