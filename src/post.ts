// Deterministic GH posting: resolve PR, fetch diff, run inline, post inline review,
// render summary, upsert sticky comment. Pure core with a thin gh-api effect.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { InlineComment } from "./types.js";
import { buildInlineComments, renderStraysSection } from "./inline.js";
import { render } from "./render.js";
import { unsafeUnwrap } from "./validate.js";
import { FindingsCodec, ResultEnvelopeCodec, PriceMapCodec } from "./schema.js";

// ---------------------------------------------------------------------------
// Effect boundary — the only impure surface
// ---------------------------------------------------------------------------

/** Signature of the `gh api` effect. Default implementation shells out to the `gh` CLI. */
export type GhApi = (args: readonly string[], stdin?: string) => Promise<string>;

/** Default effect: execFile gh. */
export const runGhApi: GhApi = (args, stdin) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      "gh",
      ["api", ...args],
      { env: process.env, encoding: "utf-8" },
      (err, stdout, stderr) => {
        if (err) {
          const stderrStr = typeof stderr === "string" && stderr.trim() ? stderr.trim() : "";
          const errStr = err instanceof Error ? err.message : "unknown error";
          reject(new Error(`gh api failed: ${stderrStr || errStr}`));
        } else {
          resolve(stdout);
        }
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });

// ---------------------------------------------------------------------------
// Post input
// ---------------------------------------------------------------------------

export interface PostInput {
  readonly repo: string;
  readonly headSha: string;
  readonly botLogin: string;
  readonly findingsPath: string;
  readonly envelopePath: string;
  readonly pricesPath: string;
  readonly templatePath: string;
  readonly route: string;
  readonly headBranch?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_MARKER = "<!-- code-review -->";
const MAX_SUGGESTION_LINES = 10;

/** Count lines in a suggestion string (empty suggestion "" = 1 line — delete range). */
const countSuggestionLines = (text: string): number => text.split("\n").length;

/** Extract and check suggestion blocks in a comment body, stripping those that are too long. */
const checkLongSuggestions = (
  comments: readonly InlineComment[],
): { readonly comments: readonly InlineComment[]; readonly longFiles: readonly string[] } => {
  const longFiles: string[] = [];
  const adjusted = comments.map((c) => {
    const match = /```suggestion\n([\s\S]*?)\n```/.exec(c.body);
    if (match?.[1] && countSuggestionLines(match[1]) > MAX_SUGGESTION_LINES) {
      longFiles.push(`${c.path}:${String(c.line)}`);
      return {
        ...c,
        body: c.body.replace(
          /```suggestion\n[\s\S]*?\n```/,
          "*(suggestion omitted — exceeds GitHub's ~10-line suggestion limit; see summary)*",
        ),
      };
    }
    return c;
  });
  return { comments: adjusted, longFiles };
};

// ---------------------------------------------------------------------------
// gh-api helpers (pure wrappers over the effect)
// ---------------------------------------------------------------------------

const resolvePrNumber = async (
  repo: string,
  headSha: string,
  headBranch: string | undefined,
  ghApi: GhApi,
): Promise<number | null> => {
  const stdout = await ghApi([`repos/${repo}/commits/${headSha}/pulls`, "--jq", ".[].number"]);
  const numbers = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (numbers.length === 0) return null;
  if (numbers.length === 1) return Number(numbers[0]);

  // Disambiguate by head_branch when available (split-brain mitigation)
  if (headBranch) {
    const stdout2 = await ghApi([
      `repos/${repo}/commits/${headSha}/pulls`,
      "--jq",
      `.[] | select(.head.ref == "${headBranch}") | .number`,
    ]);
    const match = stdout2.trim();
    if (match) return Number(match);
  }

  return Number(numbers[0]);
};

const fetchDiff = async (repo: string, prNumber: number, ghApi: GhApi): Promise<string> =>
  ghApi([
    `repos/${repo}/pulls/${String(prNumber)}`,
    "-H",
    "Accept: application/vnd.github.v3.diff",
  ]);

const postInlineReview = async (
  repo: string,
  prNumber: number,
  headSha: string,
  comments: readonly InlineComment[],
  ghApi: GhApi,
): Promise<void> => {
  const body = JSON.stringify({
    body: "",
    commit_id: headSha,
    event: "COMMENT",
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      ...(c.start_line !== undefined && c.start_side !== undefined
        ? { start_line: c.start_line, start_side: c.start_side }
        : {}),
      body: c.body,
    })),
  });
  await ghApi([`repos/${repo}/pulls/${String(prNumber)}/reviews`, "--input", "-"], body);
};

const findBotComment = async (
  repo: string,
  prNumber: number,
  botLogin: string,
  marker: string,
  ghApi: GhApi,
): Promise<{ readonly id: number; readonly body: string } | null> => {
  const stdout = await ghApi([
    `repos/${repo}/issues/${String(prNumber)}/comments`,
    "--paginate",
    "--jq",
    `.[] | select(.user.login == "${botLogin}" and (.body | startswith("${marker}"))) | {id: .id, body: .body}`,
  ]);
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1] ?? null;
  if (last === null) return null;
  const parsed = JSON.parse(last) as { id: number; body: string };
  return { id: parsed.id, body: parsed.body };
};

const patchComment = async (
  repo: string,
  commentId: number,
  body: string,
  ghApi: GhApi,
): Promise<void> => {
  await ghApi(
    [`repos/${repo}/issues/comments/${String(commentId)}`, "--input", "-"],
    JSON.stringify({ body }),
  );
};

const postComment = async (
  repo: string,
  prNumber: number,
  body: string,
  ghApi: GhApi,
): Promise<void> => {
  await ghApi(
    [`repos/${repo}/issues/${String(prNumber)}/comments`, "--input", "-"],
    JSON.stringify({ body }),
  );
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const post = async (input: PostInput, ghApi: GhApi = runGhApi): Promise<void> => {
  // 1. Resolve PR number from trusted head SHA
  const prNumber = await resolvePrNumber(input.repo, input.headSha, input.headBranch, ghApi);
  if (prNumber === null) {
    process.stderr.write(`No open PR for ${input.headSha} — nothing to post\n`);
    process.exit(0);
  }

  // 2. Fetch diff as data (no fork checkout)
  const diff = await fetchDiff(input.repo, prNumber, ghApi);

  // 3. Load + decode structured inputs — all from files, never shell-interpolated
  const findings = unsafeUnwrap(
    FindingsCodec.decode(JSON.parse(readFileSync(input.findingsPath, "utf-8")) as unknown),
  );
  const envelope = unsafeUnwrap(
    ResultEnvelopeCodec.decode(JSON.parse(readFileSync(input.envelopePath, "utf-8")) as unknown),
  );
  const prices = unsafeUnwrap(
    PriceMapCodec.decode(JSON.parse(readFileSync(input.pricesPath, "utf-8")) as unknown),
  );
  const template = readFileSync(input.templatePath, "utf-8");

  // 4. Validate findings against diff — build inline comments + demote strays
  const { comments: rawComments, strays } = buildInlineComments(findings.findings, diff);

  // 5. Warn/demote suggestions exceeding GitHub's ~10-line limit (avoids 422)
  const { comments, longFiles } = checkLongSuggestions(rawComments);
  for (const wf of longFiles) {
    process.stderr.write(
      `Warning: suggestion in ${wf} exceeds ${String(MAX_SUGGESTION_LINES)} lines — omitted from inline to avoid 422\n`,
    );
  }

  // 6. Post inline PR review as COMMENT with commit_id = head SHA (NEVER REQUEST_CHANGES)
  if (comments.length > 0) {
    await postInlineReview(input.repo, prNumber, input.headSha, comments, ghApi);
    process.stderr.write(
      `Posted ${String(comments.length)} inline comments on PR #${String(prNumber)}\n`,
    );
  }

  // 7. Render summary comment
  let body = render({
    findings,
    envelope,
    prices,
    template,
    route: input.route,
    reviewedSha: input.headSha,
  });

  // Append stray findings (demoted to summary)
  const straysMd = renderStraysSection(strays);
  if (straysMd.length > 0) body += straysMd;

  // Append long-suggestion warning (demoted to summary)
  if (longFiles.length > 0) {
    body += `\n\n---\n\n> **Note:** ${String(longFiles.length)} suggestion(s) exceeded GitHub's ~10-line inline suggestion limit and were omitted from inline comments. See the findings above for details.\n`;
  }

  // 8. Upsert sticky summary comment — trust by author identity (bot login), not marker alone
  const existing = await findBotComment(
    input.repo,
    prNumber,
    input.botLogin,
    DEFAULT_MARKER,
    ghApi,
  );
  if (existing !== null) {
    await patchComment(input.repo, existing.id, body, ghApi);
    process.stderr.write(
      `Updated sticky comment #${String(existing.id)} on PR #${String(prNumber)}\n`,
    );
  } else {
    await postComment(input.repo, prNumber, body, ghApi);
    process.stderr.write(`Posted new sticky comment on PR #${String(prNumber)}\n`);
  }
};
