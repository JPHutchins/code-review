// The issues a PR says it closes, staged with every comment for the review. Anyone can open an
// issue and get it linked to a PR, so this text is attacker-reachable: the triage screens the
// folder before any agent reads it, and the review reads it as claims, never instructions.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as t from "io-ts";
import type { GhApi } from "./gh.js";
import { parseJsonl } from "./transcript.js";
import { annotationSafe, errMsg } from "./util.js";

export const LINKED_ISSUES_DIR = "linked_issues";
export const LINKED_ISSUES_INDEX = "index.json";
export const CLOSING_ISSUES_LIMIT = 50;
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
}

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
  const closing = await fetchClosingIssues(repo, prNumber, ghApi);
  if (closing === null) return NOTHING_STAGED;
  if (closing.total > closing.issues.length) {
    warn(
      `the PR closes ${String(closing.total)} issues; only ${String(closing.issues.length)} are staged for the review`,
    );
  }
  if (closing.total === 0) return NOTHING_STAGED;
  const issues = await inBatches(closing.issues, COMMENT_READ_CONCURRENCY, async (issue) =>
    stagedIssue(
      issue,
      issue.comments.totalCount === 0
        ? []
        : await fetchComments(issue.repository.nameWithOwner, issue.number, ghApi),
    ),
  );
  try {
    const staged = writeLinkedIssues(dir, closing.total, issues);
    process.stderr.write(
      `Staged ${String(staged.issues)} issue(s) this PR closes, with ${String(staged.comments)} comment(s) (${String(staged.bytes)} bytes), in ${LINKED_ISSUES_DIR}/ for the triage and the review\n`,
    );
    return staged;
  } catch (err) {
    clearFailure(dir);
    return couldNotStage(errMsg(err));
  }
};

const NOTHING_STAGED: LinkedIssuesStaged = { indexed: false, issues: 0, comments: 0, bytes: 0 };

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

const ClosingIssuesCodec = t.type({
  totalCount: t.number,
  nodes: t.array(t.union([ClosingIssueCodec, t.null])),
});

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
      closingIssuesReferences(first: ${String(CLOSING_ISSUES_LIMIT)}) {
        totalCount
        nodes { number title body url state createdAt authorAssociation author { login } repository { nameWithOwner } comments { totalCount } }
      }
    }
  }
}`;

const COMMENTS_JQ =
  ".[] | {author: .user.login, author_association: .author_association, created_at: .created_at, url: .html_url, body: .body}";

const fetchClosingIssues = async (
  repo: string,
  prNumber: number,
  ghApi: GhApi,
): Promise<{ readonly total: number; readonly issues: readonly ClosingIssue[] } | null> => {
  const [owner = "", name = ""] = repo.split("/");
  try {
    const decoded = ClosingIssuesCodec.decode(
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
          ".data.repository.pullRequest.closingIssuesReferences",
        ]),
      ) as unknown,
    );
    if (decoded._tag === "Left") {
      warn(
        "the issues this PR closes came back in an unexpected shape, so the review runs without them",
      );
      return null;
    }
    return {
      total: decoded.right.totalCount,
      issues: decoded.right.nodes.filter((node): node is ClosingIssue => node !== null),
    };
  } catch (err) {
    warn(
      `could not read the issues this PR closes (${errMsg(err)}), so the review runs without them`,
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

const stagedIssue = (issue: ClosingIssue, comments: readonly CommentRow[] | null) => ({
  repository: issue.repository.nameWithOwner,
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
  issues: readonly StagedIssue[],
): LinkedIssuesStaged => {
  const files = issues.flatMap((issue) => issueFiles(issueFolderName(issue), issue));
  const index = JSON.stringify(
    {
      closes,
      issues: issues.map((issue) => ({
        repository: issue.repository,
        number: issue.number,
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
