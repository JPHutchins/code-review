// post (comment job) and gather (review job) resolve the PR on separate runners but from this SAME
// pure logic, so they never disagree on which PR (no split-brain).

import type { GhApi } from "./gh.js";

interface PrCandidate {
  readonly number: number;
  readonly state: string;
  readonly headRef: string;
  readonly headSha: string;
}

const CANDIDATE_JQ =
  ".[] | {number: .number, state: .state, headRef: .head.ref, headSha: .head.sha}";

const parseCandidates = (stdout: string): readonly PrCandidate[] =>
  stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PrCandidate);

// A fork PR's head commit lives on the fork, unreachable from the base repo, so
// `commits/{sha}/pulls` returns nothing for it. Fall back to matching head.sha across open PRs,
// which does reach forks. The commit endpoint stays the primary path: it is a targeted O(1)
// lookup and resolves same-repo PRs even when head.sha has since advanced past the CI commit.
export const fetchPrCandidates = async (
  repo: string,
  headSha: string,
  ghApi: GhApi,
): Promise<readonly PrCandidate[]> => {
  const direct = parseCandidates(
    await ghApi([`repos/${repo}/commits/${headSha}/pulls`, "--jq", CANDIDATE_JQ]),
  );
  if (direct.length > 0) return direct;
  const open = parseCandidates(
    await ghApi([
      `repos/${repo}/pulls?state=open&per_page=100`,
      "--paginate",
      "--jq",
      CANDIDATE_JQ,
    ]),
  );
  return open.filter((c) => c.headSha === headSha);
};

export type PrResolution =
  | { readonly kind: "none" }
  | { readonly kind: "not-open"; readonly prNumber: number; readonly state: string }
  | { readonly kind: "open"; readonly prNumber: number };

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
