// Manages the ChatOps acknowledgement reaction on a PR/issue comment: 👀 on receipt, swapped to 🚀
// (or 😕) on completion. Reactions are cosmetic, so the CLI wrapper never fails a job over them.

import * as t from "io-ts";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
import { errMsg, tryParseJson } from "./util.js";

// GitHub's fixed reaction vocabulary — there is no ✅; 🚀 (rocket) reads as "review shipped".
export const REACTIONS = [
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
] as const;
export type Reaction = (typeof REACTIONS)[number];
export const isReaction = (s: string): s is Reaction =>
  (REACTIONS as readonly string[]).includes(s);

const ReactionCodec = t.type({ id: t.number, content: t.string });

export interface ReactInput {
  readonly repo: string;
  readonly commentId: number;
  readonly add?: Reaction;
  readonly remove?: Reaction;
}

const reactionsPath = (repo: string, commentId: number): string =>
  `repos/${repo}/issues/comments/${String(commentId)}/reactions`;

const removeReactions = async (
  repo: string,
  commentId: number,
  content: Reaction,
  ghApi: GhApi,
): Promise<void> => {
  // --paginate WITHOUT --jq concatenates pages as `[..][..]` (invalid JSON) once a comment has >100
  // reactions; flatten to one record per line via --jq and decode line by line, like pr.ts. Each
  // undecodable line is logged and skipped rather than silently swallowed.
  const stdout = await ghApi([
    reactionsPath(repo, commentId),
    "--paginate",
    "--jq",
    ".[] | {id, content}",
  ]);
  for (const line of stdout.split("\n").filter((l) => l.trim() !== "")) {
    const parsed = tryParseJson(line);
    const decoded = parsed.ok ? ReactionCodec.decode(parsed.value) : undefined;
    if (decoded === undefined || decoded._tag === "Left") {
      process.stderr.write("code-review react: could not decode a reaction entry — skipping\n");
      continue;
    }
    if (decoded.right.content !== content) continue;
    // The token may delete only its OWN reactions; a 403 on someone else's is expected, not fatal.
    await ghApi([
      "--method",
      "DELETE",
      `${reactionsPath(repo, commentId)}/${String(decoded.right.id)}`,
    ]).catch((err: unknown) =>
      process.stderr.write(
        `code-review react: could not remove reaction ${String(decoded.right.id)} (${errMsg(err)}) — skipping\n`,
      ),
    );
  }
};

// Add first, then remove, so the comment is never momentarily unmarked during a 👀→🚀 swap.
export const react = async (input: ReactInput, ghApi: GhApi = runGhApi): Promise<void> => {
  if (input.add !== undefined) {
    await ghApi([
      "--method",
      "POST",
      reactionsPath(input.repo, input.commentId),
      "-f",
      `content=${input.add}`,
    ]);
  }
  if (input.remove !== undefined) {
    await removeReactions(input.repo, input.commentId, input.remove, ghApi);
  }
};
