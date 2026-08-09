import { describe, it, expect } from "vitest";
import { parseScope } from "./scope.js";

describe("parseScope — issue #139", () => {
  it("reads an absent/empty/whitespace value as absent (the reviewer infers from the README)", () => {
    expect(parseScope(undefined)).toEqual({ kind: "absent" });
    expect(parseScope("")).toEqual({ kind: "absent" });
    expect(parseScope("   ")).toEqual({ kind: "absent" });
  });

  it("parses a single language", () => {
    expect(parseScope("C")).toEqual({ kind: "ok", languages: ["C"] });
    expect(parseScope("typescript")).toEqual({ kind: "ok", languages: ["typescript"] });
  });

  it("accepts whitespace, comma, and semicolon separators interchangeably", () => {
    expect(parseScope("C C++")).toEqual({ kind: "ok", languages: ["C", "C++"] });
    expect(parseScope("c, c++, rust")).toEqual({ kind: "ok", languages: ["c", "c++", "rust"] });
    expect(parseScope("python; rust")).toEqual({ kind: "ok", languages: ["python", "rust"] });
    expect(parseScope("C,C++;Go")).toEqual({ kind: "ok", languages: ["C", "C++", "Go"] });
  });

  it("de-duplicates repeated languages preserving first-seen order", () => {
    expect(parseScope("C C++ C")).toEqual({ kind: "ok", languages: ["C", "C++"] });
  });

  it("keeps punctuation that is part of a language name (C++, C#, C/C++, Objective-C)", () => {
    expect(parseScope("C++ C# C/C++ Objective-C")).toEqual({
      kind: "ok",
      languages: ["C++", "C#", "C/C++", "Objective-C"],
    });
  });

  it("treats a value made only of separators as absent, not an empty scope", () => {
    expect(parseScope(" , ; ")).toEqual({ kind: "absent" });
  });

  it("rejects prompt-structure-breaking characters loudly rather than splicing them into the prompt", () => {
    expect(parseScope("C\nC++").kind).toBe("invalid");
    expect(parseScope("C`C++").kind).toBe("invalid");
    expect(parseScope("C<!--").kind).toBe("invalid");
    expect(parseScope("C>").kind).toBe("invalid");
    expect(parseScope("C|C++").kind).toBe("invalid");
    expect(parseScope("C\r\nC++").kind).toBe("invalid");
  });
});
