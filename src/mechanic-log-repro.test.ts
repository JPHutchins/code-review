import { describe, it, expect } from "vitest";

// Deliberate CI failure for the #219 reproduction: the mechanic route must read THIS test's
// failing-job log. Delete this file once the reproduction has served its purpose.
describe("deliberate CI failure — the #219 mechanic-log reproduction (delete me)", () => {
  it("fails on purpose so the mechanic route has a real CI failure to read", () => {
    expect(1 + 1).toBe(3);
  });
});
