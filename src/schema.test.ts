import { describe, it, expect } from "vitest";
import { withoutBrokenOptionalFields } from "./schema.js";

// A stand-in gate: `unfinished` holds non-blank strings, `change_size` is an object.
const accepts = (doc: Readonly<Record<string, unknown>>): boolean =>
  (doc["unfinished"] === undefined ||
    (Array.isArray(doc["unfinished"]) &&
      doc["unfinished"].every(
        (entry: unknown) => typeof entry === "string" && entry.trim() !== "",
      ))) &&
  (doc["change_size"] === undefined ||
    (typeof doc["change_size"] === "object" && doc["change_size"] !== null));

describe("withoutBrokenOptionalFields — drop only what is broken", () => {
  it("keeps a valid field when another best-effort field breaks", () => {
    expect(
      withoutBrokenOptionalFields(
        { summary: "s", change_size: "broken", unfinished: ["the free-threaded probe"] },
        accepts,
      ),
    ).toEqual({
      doc: { summary: "s", unfinished: ["the free-threaded probe"] },
      stripped: ["change_size"],
    });
  });

  it("keeps the usable entries of a list and names the list as recovered", () => {
    expect(
      withoutBrokenOptionalFields(
        { summary: "s", unfinished: ["the pickle probe", "  "] },
        accepts,
      ),
    ).toEqual({
      doc: { summary: "s", unfinished: ["the pickle probe"] },
      stripped: ["unfinished"],
    });
  });

  it("drops a list with no usable entry, and is null when the rest is rejected too", () => {
    expect(withoutBrokenOptionalFields({ summary: "s", unfinished: [" "] }, accepts)).toEqual({
      doc: { summary: "s" },
      stripped: ["unfinished"],
    });
    expect(withoutBrokenOptionalFields({ unfinished: [" "] }, () => false)).toBeNull();
  });
});
