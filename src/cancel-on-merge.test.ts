import { describe, it, expect } from "vitest";
import { readRepoFile as readWorkflow } from "./test-util.js";

const reviewGroupLines = (yaml: string): readonly string[] =>
  yaml
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("group: review-"));

// The review job's group and the cancel workflow's group name the same per-PR bucket from different
// event contexts — workflow_call inputs vs the pull_request payload — so map those sources to shared
// tokens before comparing.
const normalizeGroup = (group: string): string =>
  group
    .replace(/inputs\.head_repo/g, "HEADREPO")
    .replace(/github\.event\.pull_request\.head\.repo\.full_name/g, "HEADREPO")
    .replace(/inputs\.head_branch/g, "HEADBRANCH")
    .replace(/github\.event\.pull_request\.head\.ref/g, "HEADBRANCH")
    .replace(/\s+/g, "");

const cancelWorkflows = [
  ".github/workflows/review-cancel-on-merge.yaml",
  "examples/workflows/review-cancel-on-merge.yaml",
] as const;

// The cancel-on-merge workflow (#183) cancels a review only if its concurrency group resolves to the
// exact value review-reusable.yaml's review job uses; any drift is a silent no-op that looks like
// success, so pin the two together here.
describe("cancel-on-merge concurrency group (#183)", () => {
  const reviewGroups = reviewGroupLines(readWorkflow(".github/workflows/review-reusable.yaml"));
  const expected = normalizeGroup(reviewGroups[0] ?? "");

  it("review-reusable.yaml still declares a review- concurrency group", () => {
    expect(reviewGroups.length).toBeGreaterThan(0);
  });

  it("every review- group in the reusable is the same per-PR bucket", () => {
    for (const group of reviewGroups) expect(normalizeGroup(group)).toBe(expected);
  });

  for (const path of cancelWorkflows) {
    it(`${path} targets that exact group and actually cancels`, () => {
      const yaml = readWorkflow(path);
      const groups = reviewGroupLines(yaml);
      expect(groups).toHaveLength(1);
      expect(normalizeGroup(groups[0] ?? "")).toBe(expected);
      // The matching group is inert without cancel-in-progress and the close trigger; dropping either
      // is a silent no-op the group check alone would miss.
      expect(yaml).toMatch(/cancel-in-progress:\s*true/);
      expect(yaml).toMatch(/pull_request:\s*\n\s*types:\s*\[\s*closed\s*\]/);
    });
  }
});
