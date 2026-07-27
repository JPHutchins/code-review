import { describe, it, expect } from "vitest";
import type { GhApi } from "./gh.js";
import { fetchPrCandidates, resolvePr } from "./pr.js";

const sha = (n: number): string => `${"0".repeat(39)}${String(n)}`;

describe("resolvePr", () => {
  it("returns none for zero candidates", () => {
    expect(resolvePr([], "feature-branch")).toEqual({ kind: "none" });
  });

  it("selects a single open candidate regardless of headBranch", () => {
    const candidates = [{ number: 42, state: "open", headRef: "feature-branch", headSha: sha(1) }];
    expect(resolvePr(candidates, undefined)).toEqual({ kind: "open", prNumber: 42 });
  });

  it("reports not-open for a single closed candidate", () => {
    const candidates = [
      { number: 42, state: "closed", headRef: "feature-branch", headSha: sha(1) },
    ];
    expect(resolvePr(candidates, "feature-branch")).toEqual({
      kind: "not-open",
      prNumber: 42,
      state: "closed",
    });
  });

  it("disambiguates multiple candidates by matching headBranch", () => {
    const candidates = [
      { number: 42, state: "open", headRef: "other-branch", headSha: sha(1) },
      { number: 99, state: "open", headRef: "feature-branch", headSha: sha(1) },
    ];
    expect(resolvePr(candidates, "feature-branch")).toEqual({ kind: "open", prNumber: 99 });
  });

  it("falls back to the first candidate when headBranch matches none", () => {
    const candidates = [
      { number: 42, state: "open", headRef: "other-branch", headSha: sha(1) },
      { number: 99, state: "open", headRef: "another-branch", headSha: sha(1) },
    ];
    expect(resolvePr(candidates, "feature-branch")).toEqual({ kind: "open", prNumber: 42 });
  });

  it("selects the single candidate even when its headRef differs from headBranch (disambiguation only engages with >1 candidate)", () => {
    const candidates = [{ number: 42, state: "open", headRef: "other-branch", headSha: sha(1) }];
    expect(resolvePr(candidates, "feature-branch")).toEqual({ kind: "open", prNumber: 42 });
  });
});

const ndjson = (
  rows: ReadonlyArray<{ number: number; state: string; headRef: string; headSha: string }>,
): string => rows.map((r) => JSON.stringify(r)).join("\n");

describe("fetchPrCandidates", () => {
  it("resolves a fork PR by head.sha from the open-PR list (commits/{sha}/pulls misses forks)", async () => {
    const calls: string[][] = [];
    const ghApi: GhApi = (args) => {
      calls.push([...args]);
      return Promise.resolve(
        ndjson([
          { number: 42, state: "open", headRef: "main", headSha: sha(2) },
          { number: 274, state: "open", headRef: "fix/fork-branch", headSha: sha(7) },
        ]),
      );
    };
    const candidates = await fetchPrCandidates("owner/repo", sha(7), ghApi);
    expect(candidates).toEqual([
      { number: 274, state: "open", headRef: "fix/fork-branch", headSha: sha(7) },
    ]);
    expect(calls[0]?.[0]).toBe("repos/owner/repo/pulls?state=open&per_page=100");
    expect(calls[0]).toContain("--paginate");
    expect(calls[0]).toContain("--jq");
  });

  it("returns no candidates when no open PR has the head SHA", async () => {
    const ghApi: GhApi = () =>
      Promise.resolve(ndjson([{ number: 42, state: "open", headRef: "main", headSha: sha(2) }]));
    expect(await fetchPrCandidates("owner/repo", sha(9), ghApi)).toEqual([]);
  });
});
