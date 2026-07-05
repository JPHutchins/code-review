// PR resolution + diff fetch, shared by `post` (comment job) and `gather` (review job). Both jobs
// resolve independently (separate runners), but from the SAME pure logic, so they never disagree on
// which PR (SPEC §8.3 — avoid split-brain). PR resolution is a single read, never jq-interpolated.

import type { GhApi } from "./gh.js";

interface PrCandidate {
  readonly number: number;
  readonly state: string;
  readonly headRef: string;
}

export const fetchPrCandidates = async (
  repo: string,
  headSha: string,
  ghApi: GhApi,
): Promise<readonly PrCandidate[]> => {
  const stdout = await ghApi([
    `repos/${repo}/commits/${headSha}/pulls`,
    "--jq",
    ".[] | {number: .number, state: .state, headRef: .head.ref}",
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PrCandidate);
};

export type PrResolution =
  | { readonly kind: "none" }
  | { readonly kind: "not-open"; readonly prNumber: number; readonly state: string }
  | { readonly kind: "open"; readonly prNumber: number };

/** Resolve which PR to act on. Disambiguates by head branch (pure); never shells out. */
export const resolvePr = (
  candidates: readonly PrCandidate[],
  headBranch: string | undefined,
): PrResolution => {
  if (candidates.length === 0) return { kind: "none" };
  const scoped =
    candidates.length > 1 && headBranch
      ? candidates.filter((c) => c.headRef === headBranch)
      : candidates;
  const chosen = scoped[0] ?? candidates[0];
  if (chosen === undefined) return { kind: "none" };
  return chosen.state === "open"
    ? { kind: "open", prNumber: chosen.number }
    : { kind: "not-open", prNumber: chosen.number, state: chosen.state };
};

export const fetchDiff = async (repo: string, prNumber: number, ghApi: GhApi): Promise<string> =>
  ghApi([
    `repos/${repo}/pulls/${String(prNumber)}`,
    "-H",
    "Accept: application/vnd.github.v3.diff",
  ]);
