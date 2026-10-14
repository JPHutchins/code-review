import { describe, it, expect } from "vitest";
import {
  UNREADABLE_UNFINISHED_ENTRY,
  readableUnfinishedChecks,
  unfinishedNamedBy,
  withDraftUnfinished,
} from "./unfinished.js";
import type { Findings } from "./schema.js";

const decoded: Findings = {
  schema_version: "0.11.0",
  summary: "s",
  verdict: "comment",
  findings: [],
};

describe("unfinishedNamedBy — every readable check, and a stand-in for whatever was not", () => {
  it.each<[string, unknown, readonly string[]]>([
    ["an empty list", [], []],
    ["a readable list", ["a", "b"], ["a", "b"]],
    ["a bare string", "a", ["a"]],
    ["a blank string", " ", [UNREADABLE_UNFINISHED_ENTRY]],
    ["a null", null, [UNREADABLE_UNFINISHED_ENTRY]],
    ["an object", { check: "a" }, [UNREADABLE_UNFINISHED_ENTRY]],
    ["a list with a blank entry", ["a", " "], [UNREADABLE_UNFINISHED_ENTRY, "a"]],
    ["a list with a non-string entry", [1, "a"], [UNREADABLE_UNFINISHED_ENTRY, "a"]],
    [
      "an echoed stand-in beside a blank entry",
      [UNREADABLE_UNFINISHED_ENTRY, " "],
      [UNREADABLE_UNFINISHED_ENTRY],
    ],
  ])("%s", (_label, named, expected) => {
    expect(unfinishedNamedBy(named)).toEqual(expected);
  });
});

describe("readableUnfinishedChecks — only the checks a next round could do", () => {
  it.each<[string, unknown, readonly string[]]>([
    ["a null", null, []],
    ["a bare string", "a", ["a"]],
    ["a list with a blank entry", [" ", "a"], ["a"]],
  ])("%s", (_label, named, expected) => {
    expect(readableUnfinishedChecks(named)).toEqual(expected);
  });
});

describe("withDraftUnfinished — the draft's unfinished checks survive the decode", () => {
  it("leaves a document whose draft names no unfinished field untouched", () => {
    expect(withDraftUnfinished({ summary: "s" }, decoded)).toBe(decoded);
  });

  it("restores the checks a decode dropped", () => {
    expect(withDraftUnfinished({ unfinished: ["a"] }, decoded).unfinished).toEqual(["a"]);
  });

  it("ignores a draft that is not an object", () => {
    expect(withDraftUnfinished(null, decoded)).toBe(decoded);
  });
});
