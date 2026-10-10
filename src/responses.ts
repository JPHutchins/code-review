import * as t from "io-ts";
import { ID_SHAPE_RE, strictExact } from "./schema.js";
import { clipText } from "./util.js";
import {
  isAnswerWord,
  ResponseDispositionCodec,
  RulingCodec,
  type ResponseDisposition,
} from "./response-grammar.js";

export const RESPONSE_REASON_CLIP_CHARS = 300;
export const RESPONSES_PER_CHANNEL = 25;

const ChannelCodec = t.keyof({ comment: null, commit: null });

// The roles whose answers come from the maintainers, as the reviewer's note names them.
export const MAINTAINER_ASSOCIATIONS: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];

const CLOSING_DISPOSITIONS: ReadonlySet<ResponseDisposition> = new Set(["refuted", "dismissed"]);

const ResponseShape = t.type({
  id: t.string,
  disposition: ResponseDispositionCodec,
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
  readonly disposition: ResponseDisposition;
  readonly reason: string;
}

// `Review-Response: <id> <disposition> — <reason>`, the key case-insensitive like a git trailer.
// Indented at most three spaces, as a markdown paragraph is: a `>` quote, the form mentioned inline
// in prose, or a four-space code line is never a response. A verb still followed by the taught `|` alternation is a
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

// The lines an answer can sit on: outside fenced code, and with a line that is wholly one code
// span read as its content — a copy of the form as the sticky displays it, backticks kept, still
// answers, while prose that only mentions the form inline ("write `Review-Response: …`") does not.
const WHOLE_LINE_CODE_SPAN_RE = /^ {0,3}`([^`]+)`\s*$/;
const answerLines = (text: string): readonly string[] =>
  unfencedLines(text).map((line) => WHOLE_LINE_CODE_SPAN_RE.exec(line)?.[1] ?? line);

// The id token as written, unwrapped from the backticks or quotes the sticky displays it in and from
// the prose punctuation that may follow it.
const unwrapId = (token: string): string => token.replace(/^[`"']+|[`"'.,:;]+$/g, "");

// Any token parses as an id: whether it has an id's shape is the harvest's rule, not the grammar's.
const lineAnswers = (lines: readonly string[]): readonly ParsedLine[] =>
  lines.flatMap((line) => {
    const match = RESPONSE_LINE_RE.exec(line);
    const id = unwrapId(match?.[1] ?? "");
    const disposition = match?.[2]?.toLowerCase();
    return id !== "" && isAnswerWord(disposition)
      ? [
          {
            id,
            disposition,
            reason: clipText((match?.[3] ?? "").trim(), RESPONSE_REASON_CLIP_CHARS),
          },
        ]
      : [];
  });

export const parseResponseLines = (text: string): readonly ParsedLine[] =>
  lineAnswers(answerLines(text));

// A verdict table — the taught form for a PR comment, and the one implementers post unprompted — is
// read when its header's columns name an id and a disposition. Each backtick-quoted token in a row's
// id cell is an answer, or each comma-separated bare id when it quotes none; the other cells are its
// reason, the disposition's own cell included only when it says more than the verdict. A table is a
// header row, its delimiter, and the rows after it that hold a pipe; another header and delimiter
// open a new table.
const ID_IN_CELL_RE = /`([^`]+)`/g;
const ID_HEADERS: ReadonlySet<string> = new Set(["id", "ids", "finding", "findings"]);
const DISPOSITION_HEADERS: ReadonlySet<string> = new Set(["disposition", "verdict", "resolution"]);

// The cells of a row, split at each pipe no backslash escapes. A cell consumes an escape with the
// character it escapes, so the scan is linear: no backward search per pipe.
const CELL_RE = /((?:\\[\s\S]?|[^\\|])*)(\||$)/g;
const splitCells = (row: string): readonly string[] => {
  const cells = [...row.matchAll(CELL_RE)];
  return cells
    .slice(0, cells.findIndex((match) => match[2] !== "|") + 1)
    .map((match) => match[1] ?? "");
};

// A line of a table: its cells without the outer pipes, or null when it holds no unescaped pipe or
// opens another block (a list item, a heading, a quote) that a pipe inside it cannot make a row.
const BLOCK_START_RE = /^ {0,3}([-+*]\s|\d+[.)]\s|#{1,6}(\s|$)|>)/;
const tableRow = (line: string): readonly string[] | null => {
  if (!/^ {0,3}\S/.test(line) || BLOCK_START_RE.test(line)) return null;
  const split = splitCells(line.trim());
  if (split.length < 2) return null;
  const inner = split.slice(line.trim().startsWith("|") ? 1 : 0);
  return (
    inner.length > 1 && inner[inner.length - 1]?.trim() === "" ? inner.slice(0, -1) : inner
  ).map((cell) => cell.trim().replace(/\\\|/g, "|"));
};

const isDelimiter = (cells: readonly string[] | null): boolean =>
  cells !== null && cells.every((cell) => /^:?-+:?$/.test(cell));

const plainCell = (cell: string): string => cell.replace(/[*_`]/g, "").trim().toLowerCase();

// A header names a column by its first word: "Finding ID" is the id column, "Verdict / action" the
// disposition's.
const columnName = (cell: string): string => plainCell(cell).split(/[\s/]+/)[0] ?? "";

// A parenthetical in the id cell annotates the id ("(minor)", "(was `x-y`)"), never names another.
const idsInCell = (cell: string): readonly string[] => {
  const ids = cell.replace(/\([^()]*\)/g, "");
  const quoted = [...ids.matchAll(ID_IN_CELL_RE)]
    .map((match) => unwrapId((match[1] ?? "").trim()))
    .filter((id) => id !== "");
  const bare = ids
    .split(",")
    .map((piece) => unwrapId(piece.trim()))
    .filter((id) => id !== "");
  return quoted.length > 0 ? quoted : bare.every((id) => /^\S+$/.test(id)) ? bare : [];
};

// The verdict is the disposition cell's first word, emphasis and emoji aside, when that word is
// exactly one the sticky teaches. Any other cell — a synonym, a negation, prose — is unstated: its
// reason still reaches the reviewer, and only a taught word can close a finding.
const tableDisposition = (cell: string): ResponseDisposition => {
  const firstWord =
    plainCell(cell)
      .replace(/^[^a-z]+/, "")
      .split(/[^a-z]/)[0] ?? "";
  return isAnswerWord(firstWord) ? firstWord : "unstated";
};

interface VerdictColumns {
  readonly id: number;
  readonly disposition: number;
}

const rowAnswers = (cells: readonly string[], columns: VerdictColumns): readonly ParsedLine[] => {
  const dispositionCell = cells[columns.disposition] ?? "";
  const disposition = tableDisposition(dispositionCell);
  const verdictOnly = isAnswerWord(plainCell(dispositionCell));
  const reason = clipText(
    cells
      .filter(
        (cell, column) =>
          cell !== "" && column !== columns.id && !(verdictOnly && column === columns.disposition),
      )
      .join(" — "),
    RESPONSE_REASON_CLIP_CHARS,
  );
  return idsInCell(cells[columns.id] ?? "").map((id) => ({ id, disposition, reason }));
};

const namesAColumn = (name: string): boolean =>
  ID_HEADERS.has(name) || DISPOSITION_HEADERS.has(name);

// One pass over the lines, each split once: a header row followed by its delimiter opens a table,
// which runs while lines hold a pipe. Inside a table, only a row naming a column opens another; a
// data row above a stray delimiter stays a row, and the delimiter answers nothing.
const tableAnswers = (lines: readonly string[]): readonly ParsedLine[] => {
  const rows = lines.map(tableRow);
  return rows.reduce<{
    readonly columns: VerdictColumns | null;
    readonly inTable: boolean;
    readonly skipDelimiter: boolean;
    readonly answers: ParsedLine[];
  }>(
    (state, cells, index) => {
      if (state.skipDelimiter) return { ...state, skipDelimiter: false };
      if (cells === null) return { ...state, inTable: false, columns: null };
      const opensTable =
        !isDelimiter(cells) &&
        isDelimiter(rows[index + 1] ?? null) &&
        (!state.inTable || cells.map(columnName).some(namesAColumn));
      if (opensTable) {
        const header = cells.map(columnName);
        const id = header.findIndex((name) => ID_HEADERS.has(name));
        const disposition = header.findIndex((name) => DISPOSITION_HEADERS.has(name));
        return {
          ...state,
          inTable: true,
          skipDelimiter: true,
          columns: id < 0 || disposition < 0 ? null : { id, disposition },
        };
      }
      if (state.inTable && state.columns !== null && !isDelimiter(cells)) {
        state.answers.push(...rowAnswers(cells, state.columns));
      }
      return isDelimiter(rows[index + 1] ?? null) ? { ...state, skipDelimiter: true } : state;
    },
    { columns: null, inTable: false, skipDelimiter: false, answers: [] },
  ).answers;
};

export const parseResponseTables = (text: string): readonly ParsedLine[] =>
  tableAnswers(answerLines(text));

// Every answer in a text, lines then tables, read from one fence scan. Only an exact repeat — same
// id, verdict and reason — counts once; a changed verdict or an edited reason is kept.
export const parseResponses = (text: string): readonly ParsedLine[] => {
  const lines = answerLines(text);
  const seen = new Set<string>();
  return [...lineAnswers(lines), ...tableAnswers(lines)].filter((answer) => {
    const key = JSON.stringify([answer.id, answer.disposition, answer.reason]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

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

// Every answer on the PR — a Review-Response line or a verdict-table row — newest first per channel.
// Only a human account answers: another bot's comment never poses as the implementer.
export const answersFrom = (
  input: AnswerSources,
): { readonly comments: readonly Response[]; readonly commits: readonly Response[] } => {
  const comments: readonly Response[] = [...input.comments]
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
  const commits: readonly Response[] = [...input.commits].reverse().flatMap((commit) =>
    parseResponses(commit.message).map((line) => ({
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
// does a same-instant tie with a `fixed`. An unstated answer claims no verdict, so it neither closes
// an id nor reopens one.
export const closingResponses = (
  responses: readonly Response[],
  isTrusted: (response: Response) => boolean,
): readonly Response[] => newestTrustedAnswersIn(responses, isTrusted, CLOSING_DISPOSITIONS);

// A ruling counts only where it is taught: a maintainer's, on an id contested or already ruled.
// Anywhere else it claims no verdict.
export const withRulingsOn = (
  responses: readonly Response[],
  ruledIds: ReadonlySet<string>,
  isTrusted: (response: Response) => boolean,
): readonly Response[] =>
  responses.map((response) =>
    RulingCodec.is(response.disposition) && !(ruledIds.has(response.id) && isTrusted(response))
      ? { ...response, disposition: "unstated" }
      : response,
  );

// Per id, the newest trusted stated answer when every answer at that instant is one of the given
// dispositions; the lowest source_url breaks a tie among them.
export const newestTrustedAnswersIn = (
  responses: readonly Response[],
  isTrusted: (response: Response) => boolean,
  dispositions: ReadonlySet<ResponseDisposition>,
): readonly Response[] => {
  const byId = responses
    .filter((response) => response.disposition !== "unstated" && isTrusted(response))
    .reduce((groups, response) => {
      const timed = { response, at: answeredInstant(response) };
      groups.set(response.id, [...(groups.get(response.id) ?? []), timed]);
      return groups;
    }, new Map<string, readonly { readonly response: Response; readonly at: number }[]>());
  return [...byId.values()].flatMap((answers) => {
    if (answers.some(({ at }) => Number.isNaN(at))) return [];
    const latest = Math.max(...answers.map(({ at }) => at));
    const newest = answers.filter(({ at }) => at === latest).map(({ response }) => response);
    return newest.every((response) => dispositions.has(response.disposition))
      ? [...newest].sort((a, b) => (a.source_url < b.source_url ? -1 : 1)).slice(0, 1)
      : [];
  });
};
