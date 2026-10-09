import * as t from "io-ts";
import { isHuman } from "./answered.js";
import { ID_SHAPE_RE, strictExact } from "./schema.js";
import { clipText } from "./util.js";

export const RESPONSE_REASON_CLIP_CHARS = 300;
export const RESPONSES_PER_CHANNEL = 25;

const DispositionCodec = t.keyof({ fixed: null, refuted: null, dismissed: null });
const ChannelCodec = t.keyof({ comment: null, commit: null });
type Disposition = t.TypeOf<typeof DispositionCodec>;

// The response vocabulary, for every surface that teaches it.
export const DISPOSITIONS = Object.keys(DispositionCodec.keys) as readonly Disposition[];

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

// A verdict table — the per-round answer implementers post unprompted — is read when its header
// names an id column and a disposition column. Each backtick-quoted token in a row's id cell is an
// answer, and every other cell is its reason.
const TABLE_ROW_RE = /^ {0,3}\|/;
const TABLE_DELIMITER_RE = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ID_IN_CELL_RE = /`([^`]+)`/g;
const ID_HEADERS: ReadonlySet<string> = new Set(["id", "ids", "finding", "findings"]);
const DISPOSITION_HEADERS: ReadonlySet<string> = new Set([
  "disposition",
  "verdict",
  "resolution",
  "status",
  "answer",
  "response",
]);

// The phrases implementers write in a disposition cell, mapped onto the response vocabulary; the
// earliest one in the cell's first clause decides ("reproduced after merge and filed as #223" is a
// deferral). A cell naming none describes the change made, so it reads as fixed: a claim the reviewer
// verifies, never a closure.
const TABLE_VOCABULARY: readonly (readonly [RegExp, Disposition])[] = [
  [/\b(refuted|disputed|not reached|not reproduced|false positive|does not hold)\b/i, "refuted"],
  [
    /\b(dismissed|recorded|acknowledged|declined|deferred|won't fix|wontfix|out of scope|filed|tracked)\b/i,
    "dismissed",
  ],
  [/\b(fixed|resolved|addressed|moot|removed|done)\b/i, "fixed"],
];

const tableCells = (row: string): readonly string[] =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

const headerName = (cell: string): string => cell.replace(/[*_`]/g, "").trim().toLowerCase();

const tableDisposition = (cell: string): Disposition => {
  const clause = cell.replace(/[*_]/g, "").split(/[.:;—]/)[0] ?? "";
  const earliest = TABLE_VOCABULARY.flatMap(([phrase, disposition]) => {
    const match = phrase.exec(clause);
    return match === null ? [] : [{ at: match.index, disposition }];
  }).sort((a, b) => a.at - b.at)[0];
  return earliest?.disposition ?? "fixed";
};

export const parseResponseTables = (text: string): readonly ParsedLine[] => {
  const lines = unfencedLines(text);
  return lines.flatMap((line, index) => {
    if (!TABLE_ROW_RE.test(line) || !TABLE_DELIMITER_RE.test(lines[index + 1] ?? "")) return [];
    const header = tableCells(line).map(headerName);
    const idColumn = header.findIndex((name) => ID_HEADERS.has(name));
    const dispositionColumn = header.findIndex((name) => DISPOSITION_HEADERS.has(name));
    if (idColumn < 0 || dispositionColumn < 0) return [];
    const body = lines.slice(index + 2);
    const end = body.findIndex((row) => !TABLE_ROW_RE.test(row));
    return (end < 0 ? body : body.slice(0, end)).flatMap((row) => {
      const cells = tableCells(row);
      const disposition = tableDisposition(cells[dispositionColumn] ?? "");
      const reason = clipText(
        cells.filter((_, column) => column !== idColumn).join(" — "),
        RESPONSE_REASON_CLIP_CHARS,
      );
      return [...(cells[idColumn] ?? "").matchAll(ID_IN_CELL_RE)].flatMap((match) => {
        const id = unwrapId(match[1] ?? "");
        return id === "" ? [] : [{ id, disposition, reason }];
      });
    });
  });
};

// Every answer in a text, a Review-Response line before a table row for the same id.
export const parseResponses = (text: string): readonly ParsedLine[] =>
  [...parseResponseLines(text), ...parseResponseTables(text)].filter(
    (answer, index, answers) => answers.findIndex((other) => other.id === answer.id) === index,
  );

export interface HarvestInput {
  readonly repo: string;
  readonly prNumber: number;
  readonly botLogin: string;
  readonly priorIds: ReadonlySet<string>;
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

export interface Harvest {
  readonly file: ResponsesFile;
  // Response lines past a channel's cap: named by the caller, never cut silently.
  readonly dropped: number;
}

// Newest first, with the comment id breaking a same-second tie (GitHub timestamps are second-grained).
const newestFirst = (
  a: HarvestInput["comments"][number],
  b: HarvestInput["comments"][number],
): number => {
  const [left, right] = [a.created_at ?? "", b.created_at ?? ""];
  return left < right ? 1 : left > right ? -1 : b.id - a.id;
};

// Every answer on the PR — a Review-Response line or a verdict-table row — newest first per channel,
// so a long PR never pushes its recent answers out of the cap. An answer naming an id the prior round
// reported is a response; any other id-shaped one is echoed as unmatched rather than silently
// dropped. Only a human account answers:
// another bot's comment never poses as the implementer.
export const harvestResponses = (input: HarvestInput): Harvest => {
  const fromComments: readonly Response[] = [...input.comments]
    .filter((comment) => isHuman(comment.user.login, comment.user.type ?? null, input.botLogin))
    .sort(newestFirst)
    .flatMap((comment) =>
      parseResponses(comment.body ?? "").map((line) => ({
        ...line,
        channel: "comment" as const,
        source_url: `https://github.com/${input.repo}/pull/${String(input.prNumber)}#issuecomment-${String(comment.id)}`,
        author: comment.user.login,
        author_association: comment.author_association ?? null,
        created_at: comment.created_at ?? null,
      })),
    );
  const fromCommits: readonly Response[] = [...input.commits].reverse().flatMap((commit) =>
    parseResponses(commit.message).map((line) => ({
      ...line,
      channel: "commit" as const,
      source_url: `https://github.com/${input.repo}/commit/${commit.sha}`,
      author: commit.author,
      author_association: null,
      created_at: commit.date ?? null,
    })),
  );
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
