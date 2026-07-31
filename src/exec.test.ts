import { describe, it, expect, afterEach } from "vitest";
import { classifyExecError, parseTimeoutMs, subprocessTimeoutMs } from "./exec.js";

describe("parseTimeoutMs", () => {
  it("returns the fallback when the value is unset", () => {
    expect(parseTimeoutMs(undefined, 120_000)).toBe(120_000);
  });

  it("honors a positive numeric override", () => {
    expect(parseTimeoutMs("300000", 120_000)).toBe(300_000);
  });

  it("falls back for non-numeric, empty, zero, or negative values", () => {
    expect(parseTimeoutMs("", 120_000)).toBe(120_000);
    expect(parseTimeoutMs("soon", 120_000)).toBe(120_000);
    expect(parseTimeoutMs("0", 120_000)).toBe(120_000);
    expect(parseTimeoutMs("-5", 120_000)).toBe(120_000);
  });

  it("falls back above the signed-32-bit ceiling (would clamp to 1ms internally)", () => {
    expect(parseTimeoutMs("2147483647", 120_000)).toBe(2_147_483_647);
    expect(parseTimeoutMs("2147483648", 120_000)).toBe(120_000);
    expect(parseTimeoutMs("3000000000", 120_000)).toBe(120_000);
  });
});

describe("subprocessTimeoutMs", () => {
  afterEach(() => {
    delete process.env["CODE_REVIEW_SUBPROCESS_TIMEOUT_MS"];
  });

  it("defaults to 120_000 when unset", () => {
    delete process.env["CODE_REVIEW_SUBPROCESS_TIMEOUT_MS"];
    expect(subprocessTimeoutMs()).toBe(120_000);
  });

  it("honors a valid override", () => {
    process.env["CODE_REVIEW_SUBPROCESS_TIMEOUT_MS"] = "45000";
    expect(subprocessTimeoutMs()).toBe(45_000);
  });
});

describe("classifyExecError", () => {
  it("attributes a maxBuffer overflow before a timeout kill", () => {
    expect(
      classifyExecError({ killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "", 120_000),
    ).toMatch(/output exceeded .* bytes/);
  });

  it("names a timeout kill", () => {
    expect(classifyExecError({ killed: true }, "", 120_000)).toBe(
      "no response within 120000ms (killed a hung child)",
    );
  });

  it("prefers the child's stderr for an ordinary non-zero exit", () => {
    expect(classifyExecError(new Error("boom"), "  fatal: not a git repo\n", 120_000)).toBe(
      "fatal: not a git repo",
    );
  });

  it("falls back to the error message when stderr is empty", () => {
    expect(classifyExecError(new Error("spawn ENOENT"), "", 120_000)).toBe("spawn ENOENT");
  });
});
