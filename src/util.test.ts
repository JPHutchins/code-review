import { describe, it, expect } from "vitest";
import { CONTEXT_SUFFIX_RE, modelIdentity } from "./util.js";

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
    expect(CONTEXT_SUFFIX_RE.source).toBe("\\[[12]m\\]");
    expect(CONTEXT_SUFFIX_RE.test("x[1m]y")).toBe(true);
    expect(CONTEXT_SUFFIX_RE.test("x[1m]y")).toBe(true);
  });

  it("leaves ids without the suffix untouched", () => {
    expect(modelIdentity("deepseek-v4-pro")).toBe("deepseek-v4-pro");
  });
});
