import { describe, it, expect } from "vitest";
import { describeEndpoint } from "./gh.js";

describe("describeEndpoint", () => {
  it("names a path-first REST call", () => {
    expect(describeEndpoint(["repos/o/r/commits/abc/pulls", "--jq", ".[]"])).toBe(
      "repos/o/r/commits/abc/pulls",
    );
  });

  it("names the path in a --method call where the path is not args[0]", () => {
    expect(
      describeEndpoint(["--method", "DELETE", "repos/o/r/issues/comments/1/reactions/9"]),
    ).toBe("repos/o/r/issues/comments/1/reactions/9");
    expect(
      describeEndpoint([
        "--method",
        "POST",
        "repos/o/r/issues/comments/1/reactions",
        "-f",
        "content=+1",
      ]),
    ).toBe("repos/o/r/issues/comments/1/reactions");
  });

  it("names graphql calls", () => {
    expect(describeEndpoint(["graphql", "-f", "query=mutation { x }", "-f", "id=abc"])).toBe(
      "graphql",
    );
  });

  it("falls back to args[0] when no path-shaped arg is present", () => {
    expect(describeEndpoint(["user"])).toBe("user");
    expect(describeEndpoint([])).toBe("(no endpoint)");
  });
});
