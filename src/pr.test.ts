import { describe, it, expect } from "vitest";
import { resolvePr } from "./pr.js";

describe("resolvePr", () => {
  it("returns none for zero candidates", () => {
    expect(resolvePr([], "feature-branch")).toEqual({ kind: "none" });
  });

  it("selects a single open candidate regardless of headBranch", () => {
    const candidates = [{ number: 42, state: "open", headRef: "feature-branch" }];
    expect(resolvePr(candidates, undefined)).toEqual({ kind: "open", prNumber: 42 });
  });

  it("reports not-open for a single closed candidate", () => {
    const candidates = [{ number: 42, state: "closed", headRef: "feature-branch" }];
    expect(resolvePr(candidates, "feature-branch")).toEqual({
      kind: "not-open",
      prNumber: 42,
      state: "closed",
    });
  });

  it("disambiguates multiple candidates by matching headBranch", () => {
    const candidates = [
      { number: 42, state: "open", headRef: "other-branch" },
      { number: 99, state: "open", headRef: "feature-branch" },
    ];
    expect(resolvePr(candidates, "feature-branch")).toEqual({ kind: "open", prNumber: 99 });
  });

  it("falls back to the first candidate when headBranch matches none", () => {
    const candidates = [
      { number: 42, state: "open", headRef: "other-branch" },
      { number: 99, state: "open", headRef: "another-branch" },
    ];
    expect(resolvePr(candidates, "feature-branch")).toEqual({ kind: "open", prNumber: 42 });
  });

  it("selects the single candidate even when its headRef differs from headBranch (disambiguation only engages with >1 candidate)", () => {
    const candidates = [{ number: 42, state: "open", headRef: "other-branch" }];
    expect(resolvePr(candidates, "feature-branch")).toEqual({ kind: "open", prNumber: 42 });
  });
});
