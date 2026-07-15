import { describe, it, expect, vi } from "vitest";
import type { GhApi } from "./gh.js";
import { react, isReaction, REACTIONS } from "./react.js";

interface RecordedCall {
  readonly args: readonly string[];
}

const mkMockGhApi = (
  responses: ReadonlyArray<{
    readonly match: (args: readonly string[]) => boolean;
    readonly response: string | Error;
  }>,
): { readonly api: GhApi; readonly calls: () => readonly RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const api: GhApi = (args) => {
    calls.push({ args: [...args] });
    for (const r of responses) {
      if (r.match(args))
        return r.response instanceof Error
          ? Promise.reject(r.response)
          : Promise.resolve(r.response);
    }
    return Promise.reject(new Error(`Unexpected gh api call: ${args.join(" ")}`));
  };
  return { api, calls: () => calls };
};

const REACTIONS_PATH = "repos/owner/repo/issues/comments/7/reactions";
const isPost = (a: readonly string[]): boolean => a[0] === "--method" && a[1] === "POST";
const isDelete = (a: readonly string[]): boolean => a[0] === "--method" && a[1] === "DELETE";
const isList = (a: readonly string[]): boolean =>
  a[0] === REACTIONS_PATH && a.includes("--paginate");

describe("isReaction", () => {
  it("accepts the eight GitHub reaction contents and rejects anything else", () => {
    for (const r of REACTIONS) expect(isReaction(r)).toBe(true);
    expect(isReaction("white_check_mark")).toBe(false);
    expect(isReaction("thumbsup")).toBe(false);
  });
});

describe("react — add", () => {
  it("POSTs the reaction content when only --add is given", async () => {
    const { api, calls } = mkMockGhApi([{ match: isPost, response: "{}" }]);
    await react({ repo: "owner/repo", commentId: 7, add: "eyes" }, api);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.args).toEqual(["--method", "POST", REACTIONS_PATH, "-f", "content=eyes"]);
  });
});

describe("react — remove", () => {
  it("lists reactions and deletes only those matching the content", async () => {
    const { api, calls } = mkMockGhApi([
      {
        match: isList,
        response: JSON.stringify([
          { id: 1, content: "eyes" },
          { id: 2, content: "heart" },
          { id: 3, content: "eyes" },
        ]),
      },
      { match: isDelete, response: "" },
    ]);
    await react({ repo: "owner/repo", commentId: 7, remove: "eyes" }, api);
    const deletes = calls().filter((c) => isDelete(c.args));
    expect(deletes.map((c) => c.args[2])).toEqual([`${REACTIONS_PATH}/1`, `${REACTIONS_PATH}/3`]);
    expect(calls().some((c) => c.args[2] === `${REACTIONS_PATH}/2`)).toBe(false);
  });

  it("tolerates a per-reaction delete failure (can't delete another user's reaction)", async () => {
    const { api } = mkMockGhApi([
      { match: isList, response: JSON.stringify([{ id: 1, content: "eyes" }]) },
      { match: isDelete, response: new Error("403 Forbidden") },
    ]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      react({ repo: "owner/repo", commentId: 7, remove: "eyes" }, api),
    ).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("could not remove reaction"));
    stderrSpy.mockRestore();
  });

  it("no-ops the removal when the reactions list can't be decoded", async () => {
    const { api, calls } = mkMockGhApi([{ match: isList, response: '{"not":"an array"}' }]);
    await react({ repo: "owner/repo", commentId: 7, remove: "eyes" }, api);
    expect(calls().some((c) => isDelete(c.args))).toBe(false);
  });
});

describe("react — swap (add then remove)", () => {
  it("adds the new reaction BEFORE removing the old one", async () => {
    const { api, calls } = mkMockGhApi([
      { match: isPost, response: "{}" },
      { match: isList, response: JSON.stringify([{ id: 1, content: "eyes" }]) },
      { match: isDelete, response: "" },
    ]);
    await react({ repo: "owner/repo", commentId: 7, add: "rocket", remove: "eyes" }, api);
    const kinds = calls().map((c) =>
      isPost(c.args) ? "post" : isDelete(c.args) ? "delete" : "list",
    );
    expect(kinds).toEqual(["post", "list", "delete"]);
    expect(calls()[0]?.args.at(-1)).toBe("content=rocket");
  });
});
