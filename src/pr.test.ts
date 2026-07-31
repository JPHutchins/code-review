import { describe, it, expect } from "vitest";
import type { GhApi } from "./gh.js";
import { fetchPrCandidates, resolvePr } from "./pr.js";

const sha = (n: number): string => String(n).padStart(40, "0");

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

  it("prefers an open candidate over a closed one that shares the head SHA and branch", () => {
    const candidates = [
      { number: 42, state: "closed", headRef: "feature-branch", headSha: sha(1) },
      { number: 99, state: "open", headRef: "feature-branch", headSha: sha(1) },
    ];
    expect(resolvePr(candidates, "feature-branch")).toEqual({ kind: "open", prNumber: 99 });
  });
});

const ndjson = (
  rows: ReadonlyArray<{ number: number; state: string; headRef: string; headSha: string }>,
): string => rows.map((r) => JSON.stringify(r)).join("\n");

const isCommitPulls = (a: readonly string[]): boolean =>
  a[0]?.startsWith("repos/owner/repo/commits/") ?? false;
const isOpenPulls = (a: readonly string[]): boolean =>
  a[0]?.startsWith("repos/owner/repo/pulls?state=open") ?? false;

const mkRoutedGhApi = (
  commitPulls: string,
  openPulls: string,
): { readonly api: GhApi; readonly calls: () => readonly (readonly string[])[] } => {
  const calls: (readonly string[])[] = [];
  const api: GhApi = (args) => {
    calls.push([...args]);
    if (isCommitPulls(args)) return Promise.resolve(commitPulls);
    if (isOpenPulls(args)) return Promise.resolve(openPulls);
    return Promise.reject(new Error(`Unexpected gh api call: ${args.join(" ")}`));
  };
  return { api, calls: () => calls };
};

describe("fetchPrCandidates", () => {
  it("resolves a same-repo PR directly from commits/{sha}/pulls without listing open PRs", async () => {
    const { api, calls } = mkRoutedGhApi(
      ndjson([{ number: 42, state: "open", headRef: "feature", headSha: sha(1) }]),
      "",
    );
    const candidates = await fetchPrCandidates("owner/repo", sha(1), api);
    expect(candidates).toEqual([
      { number: 42, state: "open", headRef: "feature", headSha: sha(1) },
    ]);
    expect(calls().some(isOpenPulls)).toBe(false);
  });

  it("falls back to matching head.sha across open PRs when the commit endpoint is empty (fork PRs)", async () => {
    const { api, calls } = mkRoutedGhApi(
      "",
      ndjson([
        { number: 42, state: "open", headRef: "main", headSha: sha(2) },
        { number: 274, state: "open", headRef: "fix/fork-branch", headSha: sha(7) },
      ]),
    );
    const candidates = await fetchPrCandidates("owner/repo", sha(7), api);
    expect(candidates).toEqual([
      { number: 274, state: "open", headRef: "fix/fork-branch", headSha: sha(7) },
    ]);
    const openCall = calls().find(isOpenPulls);
    expect(openCall).toContain("--paginate");
    expect(openCall).toContain("--jq");
  });

  it("returns none when neither the commit endpoint nor any open PR head.sha matches", async () => {
    const { api } = mkRoutedGhApi(
      "",
      ndjson([{ number: 42, state: "open", headRef: "main", headSha: sha(2) }]),
    );
    expect(await fetchPrCandidates("owner/repo", sha(9), api)).toEqual([]);
  });

  it("falls through to the open-PR listing when the commit endpoint 403s (fork PR, read-scoped token)", async () => {
    const calls: (readonly string[])[] = [];
    const api: GhApi = (args) => {
      calls.push([...args]);
      if (isCommitPulls(args)) {
        return Promise.reject(
          new Error(
            `gh api ${args[0] ?? ""} failed: gh: Resource not accessible by integration (HTTP 403)`,
          ),
        );
      }
      if (isOpenPulls(args)) {
        return Promise.resolve(
          ndjson([{ number: 27, state: "open", headRef: "fork:fix", headSha: sha(7) }]),
        );
      }
      return Promise.reject(new Error(`Unexpected gh api call: ${args.join(" ")}`));
    };
    const candidates = await fetchPrCandidates("owner/repo", sha(7), api);
    expect(candidates).toEqual([
      { number: 27, state: "open", headRef: "fork:fix", headSha: sha(7) },
    ]);
    expect(calls.some(isOpenPulls)).toBe(true);
  });

  it("propagates when the fork listing itself fails — a genuine permission gap is never swallowed", async () => {
    const api: GhApi = (args) => {
      if (isCommitPulls(args)) return Promise.reject(new Error("commit endpoint 403"));
      return Promise.reject(new Error("gh api repos/owner/repo/pulls?state=open failed: HTTP 403"));
    };
    await expect(fetchPrCandidates("owner/repo", sha(7), api)).rejects.toThrow("pulls?state=open");
  });
});
