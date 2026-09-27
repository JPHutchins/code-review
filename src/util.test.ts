import { describe, it, expect } from "vitest";
import { CONTEXT_SUFFIX_RE, modelIdentity, ONE_M_SUFFIX_RE } from "./util.js";

// The grammar pins (issue #209): the agent CLI's resolver tests /\[1m\]/i UNANCHORED — the
// window is granted wherever the suffix appears — so the canonicalizer strips wherever it
// appears, in either case, and the guard's grammar is the same non-global pattern.
describe("modelIdentity — the [1m] suffix grammar", () => {
  it("strips the trailing suffix, case-insensitively", () => {
    expect(modelIdentity("deepseek-v4-pro[1m]")).toBe("deepseek-v4-pro");
    expect(modelIdentity("deepseek-v4-pro[1M]")).toBe("deepseek-v4-pro");
    expect(modelIdentity("deepseek-v4-pro[2m]")).toBe("deepseek-v4-pro");
  });

  it("strips a mid-id suffix — the CLI grants the window wherever it appears", () => {
    expect(modelIdentity("deepseek-v4-pro[1m]-preview")).toBe("deepseek-v4-pro-preview");
  });

  it("strips every occurrence", () => {
    expect(modelIdentity("[1m]deepseek[1m]")).toBe("deepseek");
  });

  it("the guard grammar is the same pattern, non-global (a stateful /g alternates in .test)", () => {
    expect(CONTEXT_SUFFIX_RE.global).toBe(false);
    expect(CONTEXT_SUFFIX_RE.test("x[1m]y")).toBe(true);
    expect(CONTEXT_SUFFIX_RE.test("x[1m]y")).toBe(true);
  });

  it("the canonicalizer and the guard grammar agree on a sample of ids", () => {
    for (const id of ["deepseek-v4-pro", "deepseek-v4-pro[1m]", "x[2M]y", "[1m]-preview"]) {
      // The canonicalizer strips exactly when the shared pattern matches — the ONE grammar's
      // two forms cannot drift (issue #209 review r2).
      expect(modelIdentity(id) === id).toBe(!CONTEXT_SUFFIX_RE.test(id));
    }
  });

  it("the 1M-declaration pattern is [1m] only — a [2m] suffix never claims the window", () => {
    expect(ONE_M_SUFFIX_RE.test("deepseek-v4-pro[1m]")).toBe(true);
    expect(ONE_M_SUFFIX_RE.test("deepseek-v4-pro[2m]")).toBe(false);
  });

  it("leaves ids without the suffix untouched", () => {
    expect(modelIdentity("deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });
});
