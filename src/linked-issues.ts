// The issues a PR says it closes, staged with every comment for the review. Anyone can open an
// issue and get it linked to a PR, so this text is attacker-reachable: the triage screens the
// folder before any agent reads it, and the review reads it as claims, never instructions.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as t from "io-ts";
import type { GhApi } from "./gh.js";
import { parseJsonl } from "./transcript.js";
import { annotationSafe, errMsg } from "./util.js";

export const LINKED_ISSUES_DIR = "linked_issues";
export const LINKED_ISSUES_INDEX = "index.json";
export const CLOSING_ISSUES_LIMIT = 50;

export interface LinkedIssuesStaged {
  readonly issues: number;
  readonly comments: number;
  readonly bytes: number;
}

export const stageLinkedIssues = async (
  repo: string,
  prNumber: number,
  outDir: string,
  ghApi: GhApi,
): Promise<LinkedIssuesStaged> => {
  const closing = await fetchClosingIssues(repo, prNumber, ghApi);
  if (closing === null || closing.issues.length === 0) return NOTHING_STAGED;
  if (closing.total > closing.issues.length) {
    warn(
      `the PR closes ${String(closing.total)} issues; only the first ${String(closing.issues.length)} are staged for the review`,
    );
  }
  const staged = writeLinkedIssues(
    join(outDir, LINKED_ISSUES_DIR),
    await Promise.all(
      closing.issues.map(async (issue) =>
        stagedIssue(
          issue,
          await fetchComments(issue.repository.nameWithOwner, issue.number, ghApi),
        ),
      ),
    ),
  );
  process.stderr.write(
    `Staged ${String(staged.issues)} issue(s) this PR closes, with ${String(staged.comments)} comment(s) (${String(staged.bytes)} bytes), in ${LINKED_ISSUES_DIR}/ for the triage and the review\n`,
  );
  return staged;
};

const NOTHING_STAGED: LinkedIssuesStaged = { issues: 0, comments: 0, bytes: 0 };

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
        nodes { number title body url state createdAt authorAssociation author { login } repository { nameWithOwner } }
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

const writeLinkedIssues = (dir: string, issues: readonly StagedIssue[]): LinkedIssuesStaged => {
  mkdirSync(dir, { recursive: true });
  const files = issues.map((issue) => ({
    issue,
    file: issueFileName(issue),
    json: JSON.stringify(issue),
  }));
  const index = JSON.stringify(
    files.map(({ issue, file }) => ({
      repository: issue.repository,
      number: issue.number,
      url: issue.url,
      title: issue.title,
      comments: issue.comments === null ? null : issue.comments.length,
      file,
    })),
  );
  files.forEach(({ file, json }) => {
    writeFileSync(join(dir, file), json);
  });
  writeFileSync(join(dir, LINKED_ISSUES_INDEX), index);
  return {
    issues: issues.length,
    comments: issues.reduce((sum, issue) => sum + (issue.comments?.length ?? 0), 0),
    bytes: [index, ...files.map(({ json }) => json)].reduce(
      (sum, text) => sum + Buffer.byteLength(text, "utf8"),
      0,
    ),
  };
};

// GitHub owners never contain an underscore, so `__` separates owner from repository unambiguously.
const issueFileName = (issue: StagedIssue): string =>
  `${issue.repository
    .split("/")
    .map((part) => part.replaceAll(/[^A-Za-z0-9._-]/g, "_"))
    .join("__")}__${String(issue.number)}.json`;

const warn = (message: string): void => {
  process.stderr.write(`${annotationSafe(`::warning::${message}`)}\n`);
};
