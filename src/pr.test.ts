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
});
