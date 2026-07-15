// Manages the ChatOps acknowledgement reaction on a PR/issue comment: 👀 on receipt, swapped to 🚀
// (or 😕) on completion. Reactions are cosmetic, so the CLI wrapper never fails a job over them.

import * as t from "io-ts";
import type { GhApi } from "./gh.js";
import { runGhApi } from "./gh.js";
import { errMsg } from "./util.js";

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
const ReactionsCodec = t.array(ReactionCodec);

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
  const stdout = await ghApi([reactionsPath(repo, commentId), "--paginate"]);
  const decoded = ReactionsCodec.decode(JSON.parse(stdout || "[]") as unknown);
  if (decoded._tag === "Left") return;
  for (const reaction of decoded.right.filter((r) => r.content === content)) {
    // The token may delete only its OWN reactions; a 403 on someone else's is expected, not fatal.
    await ghApi([
      "--method",
      "DELETE",
      `${reactionsPath(repo, commentId)}/${String(reaction.id)}`,
    ]).catch((err: unknown) =>
      process.stderr.write(
        `code-review react: could not remove reaction ${String(reaction.id)} (${errMsg(err)}) — skipping\n`,
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
