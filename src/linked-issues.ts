// The issues a PR says it closes, and the ones its description names, staged with every comment for
// the review. Anyone can open an issue and get it linked to a PR, so this text is attacker-reachable:
// the triage screens the folder before any agent reads it, and the review reads it as claims, never
// instructions.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as t from "io-ts";
import type { GhApi } from "./gh.js";
import { parseJsonl } from "./transcript.js";
import { annotationSafe, errMsg } from "./util.js";

export const LINKED_ISSUES_DIR = "linked_issues";
export const LINKED_ISSUES_INDEX = "index.json";
export const CLOSING_ISSUES_LIMIT = 50;
// Closing and referenced issues together; the closing ones are staged first.
export const LINKED_ISSUES_LIMIT = 50;
// The comment reads are bounded like the passed run's log staging: the gather step has no timeout.
export const COMMENT_READ_CONCURRENCY = 8;
// The agents read these files a line at a time and cut a long line short, so a longer line is
// folded: every character of an issue stays reachable to the triage that screens it.
export const READABLE_LINE_CHARS = 1000;

export interface LinkedIssuesStaged {
  // This run wrote index.json: the workflow tells the agents about the folder only then, never on
  // the strength of files an earlier gather left behind.
  readonly indexed: boolean;
  readonly issues: number;
  readonly comments: number;
  readonly bytes: number;
  // body.md plus comment files: what the triage reads one by one.
  readonly files: number;
}

// The triage reads every staged file, so its wall clock grows with them: three minutes, a minute more
// per ten files, at most fifteen.
export const triageWallSeconds = (files: number): number =>
  Math.min(15 * 60, 3 * 60 + 60 * Math.ceil(files / 10));

// Writes the folder from scratch, so it holds exactly what index.json lists; any failure stages
// nothing and warns, because the review runs fine without the issues. A folder this module did not
// write (no index.json) is never removed.
export const stageLinkedIssues = async (
  repo: string,
  prNumber: number,
  outDir: string,
  ghApi: GhApi,
): Promise<LinkedIssuesStaged> => {
  const dir = join(outDir, LINKED_ISSUES_DIR);
  const cleared = clearFailure(dir);
  if (cleared !== null) return couldNotStage(cleared);
  const pr = await fetchPrIssues(repo, prNumber, ghApi);
  if (pr === null) return NOTHING_STAGED;
  const closing = pr.closing;
  if (closing.total > closing.issues.length) {
    warn(
      `the PR closes ${String(closing.total)} issues; only ${String(closing.issues.length)} are staged for the review`,
    );
  }
  const closingKeys = new Set(
    closing.issues.map((issue) => issueKey(issue.repository.nameWithOwner, issue.number)),
  );
  const named = referencedIssues(pr.body, repo, prNumber).filter(
    (ref) => !closingKeys.has(issueKey(ref.repository, ref.number)),
  );
  const room = Math.max(0, LINKED_ISSUES_LIMIT - closing.issues.length);
  if (named.length > room) {
    warn(
      `the PR description names ${String(named.length)} more issues; only ${String(room)} are staged for the review`,
    );
  }
  const referenced = (
    await inBatches(named.slice(0, room), COMMENT_READ_CONCURRENCY, (ref) =>
      fetchReferencedIssue(ref, ghApi),
    )
  ).filter((issue): issue is ClosingIssue => issue !== null);
  // An index still says how many the PR closes when the token can see none of them.
  if (closing.total === 0 && referenced.length === 0) return NOTHING_STAGED;
  const issues = await inBatches(
    [
      ...closing.issues.map((issue) => ({ issue, relation: "closes" as const })),
      ...referenced.map((issue) => ({ issue, relation: "references" as const })),
    ],
    COMMENT_READ_CONCURRENCY,
    async ({ issue, relation }) =>
      stagedIssue(
        issue,
        relation,
        issue.comments.totalCount === 0
          ? []
          : await fetchComments(issue.repository.nameWithOwner, issue.number, ghApi),
      ),
  );
  try {
    const staged = writeLinkedIssues(dir, closing.total, referenced.length, issues);
    process.stderr.write(
      `Staged ${String(staged.issues)} issue(s) this PR closes or names, with ${String(staged.comments)} comment(s) (${String(staged.files)} files, ${String(staged.bytes)} bytes), in ${LINKED_ISSUES_DIR}/ for the triage and the review\n`,
    );
    return staged;
  } catch (err) {
    clearFailure(dir);
    return couldNotStage(errMsg(err));
  }
};

const NOTHING_STAGED: LinkedIssuesStaged = {
  indexed: false,
  issues: 0,
  comments: 0,
  bytes: 0,
  files: 0,
};

const couldNotStage = (reason: string): LinkedIssuesStaged => {
  warn(`could not stage the issues this PR closes (${reason}), so the review runs without them`);
  return NOTHING_STAGED;
};

const clearFailure = (dir: string): string | null => {
  if (existsSync(dir) && !existsSync(join(dir, LINKED_ISSUES_INDEX))) {
    return `${dir} exists and was not written by code-review`;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return null;
  } catch (err) {
    return errMsg(err);
  }
};

const ClosingIssueCodec = t.type({
  number: t.number,
  title: t.string,
  body: t.union([t.string, t.null]),
  url: t.string,
  state: t.string,
  createdAt: t.union([t.string, t.null]),
  authorAssociation: t.union([t.string, t.null]),
  author: t.union([t.type({ login: t.string }), t.null]),
  repository: t.type({ nameWithOwner: t.string }),
  comments: t.type({ totalCount: t.number }),
});
type ClosingIssue = t.TypeOf<typeof ClosingIssueCodec>;

const PrIssuesCodec = t.type({
  body: t.union([t.string, t.null]),
  closingIssuesReferences: t.type({
    totalCount: t.number,
    nodes: t.array(t.union([ClosingIssueCodec, t.null])),
  }),
});

// A REST issue, shaped like a closing-issues node; `pull` marks a pull request, which is not staged.
const ReferencedIssueCodec = t.intersection([ClosingIssueCodec, t.type({ pull: t.boolean })]);

const CommentRowCodec = t.type({
  author: t.union([t.string, t.null]),
  author_association: t.union([t.string, t.null]),
  created_at: t.union([t.string, t.null]),
  url: t.union([t.string, t.null]),
  body: t.union([t.string, t.null]),
});
type CommentRow = t.TypeOf<typeof CommentRowCodec>;

const CLOSING_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      body
      closingIssuesReferences(first: ${String(CLOSING_ISSUES_LIMIT)}) {
        totalCount
        nodes { number title body url state createdAt authorAssociation author { login } repository { nameWithOwner } comments { totalCount } }
      }
    }
  }
}`;

const ISSUE_JQ =
  '{number, title, body, url: .html_url, state: (.state | ascii_upcase), createdAt: .created_at, authorAssociation: .author_association, author: (if .user then {login: .user.login} else null end), repository: {nameWithOwner: (.repository_url | sub("^.*/repos/"; ""))}, comments: {totalCount: .comments}, pull: (.pull_request != null)}';

const COMMENTS_JQ =
  ".[] | {author: .user.login, author_association: .author_association, created_at: .created_at, url: .html_url, body: .body}";

const fetchPrIssues = async (
  repo: string,
  prNumber: number,
  ghApi: GhApi,
): Promise<{
  readonly body: string;
  readonly closing: { readonly total: number; readonly issues: readonly ClosingIssue[] };
} | null> => {
  const [owner = "", name = ""] = repo.split("/");
  try {
    const decoded = PrIssuesCodec.decode(
      JSON.parse(
        await ghApi([
          "graphql",
          "-f",
          `query=${CLOSING_ISSUES_QUERY}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `number=${String(prNumber)}`,
          "--jq",
          ".data.repository.pullRequest",
        ]),
      ) as unknown,
    );
    if (decoded._tag === "Left") {
      warn(
        "the issues this PR closes came back in an unexpected shape, so the review runs without them",
      );
      return null;
    }
    const links = decoded.right.closingIssuesReferences;
    return {
      body: decoded.right.body ?? "",
      closing: {
        total: links.totalCount,
        issues: links.nodes.filter((node): node is ClosingIssue => node !== null),
      },
    };
  } catch (err) {
    warn(
      `could not read the issues this PR closes (${errMsg(err)}), so the review runs without them`,
    );
    return null;
  }
};

type IssueRef = { readonly repository: string; readonly number: number };

const issueKey = (repository: string, number: number): string =>
  `${repository.toLowerCase()}#${String(number)}`;

// The issues a PR description names — a github.com issue URL, owner/repo#N, or a bare #N in this
// repository — in order, once each, without the PR itself. Code blocks and inline code are skipped:
// a #N there is code, not a reference. Only the description: it is the PR author's, while anyone
// can comment.
export const referencedIssues = (
  body: string,
  repo: string,
  prNumber: number,
): readonly IssueRef[] =>
  [
    ...body
      .replaceAll(/```[\s\S]*?```/g, " ")
      .replaceAll(/`[^`\n]*`/g, " ")
      .matchAll(
        /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|(?<![\w./-])([\w.-]+\/[\w.-]+)#(\d+)(?![\w-])|(?<![\w&/#])#(\d+)(?![\w-])/g,
      ),
  ]
    .map((m) => ({
      repository: m[1] ?? m[3] ?? repo,
      number: Number(m[2] ?? m[4] ?? m[5]),
    }))
    .filter((ref) => issueKey(ref.repository, ref.number) !== issueKey(repo, prNumber))
    .filter(
      (ref, index, all) =>
        all.findIndex(
          (other) =>
            issueKey(other.repository, other.number) === issueKey(ref.repository, ref.number),
        ) === index,
    );

// A named issue the token can read; a pull request is skipped quietly, an unreadable one with a
// warning.
const fetchReferencedIssue = async (ref: IssueRef, ghApi: GhApi): Promise<ClosingIssue | null> => {
  try {
    const decoded = ReferencedIssueCodec.decode(
      JSON.parse(
        await ghApi([`repos/${ref.repository}/issues/${String(ref.number)}`, "--jq", ISSUE_JQ]),
      ) as unknown,
    );
    if (decoded._tag === "Left") {
      warn(
        `${ref.repository}#${String(ref.number)} came back in an unexpected shape, so it is not staged`,
      );
      return null;
    }
    const { pull, ...issue } = decoded.right;
    return pull ? null : issue;
  } catch (err) {
    warn(
      `could not read ${ref.repository}#${String(ref.number)} (${errMsg(err)}), so it is not staged`,
    );
    return null;
  }
};

// Every comment, unclipped: the triage screens all of it, and a reproduction often lives in a reply.
const fetchComments = async (
  repository: string,
  issueNumber: number,
  ghApi: GhApi,
): Promise<readonly CommentRow[] | null> => {
  try {
    const rows = parseJsonl(
      await ghApi([
        `repos/${repository}/issues/${String(issueNumber)}/comments`,
        "--paginate",
        "--jq",
        COMMENTS_JQ,
      ]),
    );
    const decoded = t.array(CommentRowCodec).decode(rows);
    if (decoded._tag === "Right") return decoded.right;
    warn(
      `the comments on ${repository}#${String(issueNumber)} came back in an unexpected shape, so the issue is staged without them`,
    );
    return null;
  } catch (err) {
    warn(
      `could not read the comments on ${repository}#${String(issueNumber)} (${errMsg(err)}), so the issue is staged without them`,
    );
    return null;
  }
};

const inBatches = async <A, B>(
  items: readonly A[],
  size: number,
  each: (item: A) => Promise<B>,
): Promise<readonly B[]> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  ).reduce<Promise<readonly B[]>>(
    async (done, batch) => [...(await done), ...(await Promise.all(batch.map(each)))],
    Promise.resolve([]),
  );

const stagedIssue = (
  issue: ClosingIssue,
  relation: "closes" | "references",
  comments: readonly CommentRow[] | null,
) => ({
  repository: issue.repository.nameWithOwner,
  relation,
  number: issue.number,
  url: issue.url,
  title: issue.title,
  state: issue.state,
  author: issue.author?.login ?? null,
  author_association: issue.authorAssociation,
  created_at: issue.createdAt,
  body: issue.body ?? "",
  comments,
});
type StagedIssue = ReturnType<typeof stagedIssue>;

// One folder per issue: issue.json carries who wrote what and when, which a body cannot forge, and
// body.md plus one comment-NNN.md per comment carry the text with its own line breaks.
const writeLinkedIssues = (
  dir: string,
  closes: number,
  references: number,
  issues: readonly StagedIssue[],
): LinkedIssuesStaged => {
  const files = issues.flatMap((issue) => issueFiles(issueFolderName(issue), issue));
  const index = JSON.stringify(
    {
      closes,
      references,
      issues: issues.map((issue) => ({
        repository: issue.repository,
        number: issue.number,
        relation: issue.relation,
        url: issue.url,
        title: issue.title,
        folder: issueFolderName(issue),
        comments: issue.comments === null ? null : issue.comments.length,
      })),
    },
    null,
    2,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LINKED_ISSUES_INDEX), index);
  files.forEach(({ path, text }) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  });
  return {
    indexed: true,
    issues: issues.length,
    comments: issues.reduce((sum, issue) => sum + (issue.comments?.length ?? 0), 0),
    bytes: [index, ...files.map(({ text }) => text)].reduce(
      (sum, text) => sum + Buffer.byteLength(text, "utf8"),
      0,
    ),
    files: files.filter(({ path }) => !path.endsWith("issue.json")).length,
  };
};

const issueFiles = (
  folder: string,
  issue: StagedIssue,
): readonly { readonly path: string; readonly text: string }[] => [
  {
    path: join(folder, "issue.json"),
    text: JSON.stringify(
      {
        ...issue,
        body: "body.md",
        comments:
          issue.comments === null
            ? null
            : issue.comments.map(({ body: _body, ...comment }, i) => ({
                ...comment,
                file: commentFileName(i, issue.comments?.length ?? 0),
              })),
      },
      null,
      2,
    ),
  },
  { path: join(folder, "body.md"), text: readable(issue.body) },
  ...(issue.comments ?? []).map((comment, i, all) => ({
    path: join(folder, commentFileName(i, all.length)),
    text: readable(comment.body ?? ""),
  })),
];

// GitHub owners never contain an underscore, so `__` separates owner from repository unambiguously.
const issueFolderName = (issue: StagedIssue): string =>
  `${issue.repository
    .split("/")
    .map((part) => part.replaceAll(/[^A-Za-z0-9._-]/g, "_"))
    .join("__")}__${String(issue.number)}`;

const commentFileName = (index: number, count: number): string =>
  `comment-${String(index + 1).padStart(Math.max(3, String(count).length), "0")}.md`;

const readable = (text: string): string =>
  text
    .split("\n")
    .flatMap((line) =>
      ((chars: readonly string[]) =>
        chars.length <= READABLE_LINE_CHARS
          ? [line]
          : Array.from({ length: Math.ceil(chars.length / READABLE_LINE_CHARS) }, (_, i) =>
              chars.slice(i * READABLE_LINE_CHARS, (i + 1) * READABLE_LINE_CHARS).join(""),
            ))(Array.from(line)),
    )
    .join("\n");

const warn = (message: string): void => {
  process.stderr.write(`${annotationSafe(`::warning::${message}`)}\n`);
};
