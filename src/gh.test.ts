import { describe, it, expect, vi, beforeEach } from "vitest";
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

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));

vi.mock("./exec.js", () => ({
  execFileWithTimeout: (...args: unknown[]): Promise<string> =>
    mockExec(...args) as Promise<string>,
  subprocessTimeoutMs: () => 1,
}));

// The escape-flag boundary: newer gh refuses raw responses carrying terminal escapes unless told to
// allow them — the refusal names the flag, so each call retries plain-then-flagged against the error
// it actually got, memoizing flag-first once a refusal proves the gh supports the flag.
describe("runGhApi — the escape-retry boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExec.mockReset();
    mockExec.mockResolvedValue("");
  });

  it("passes plain first and, on a refusal, retries with the flag — memoized for later calls", async () => {
    mockExec
      .mockRejectedValueOnce(
        new Error(
          "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway",
        ),
      )
      .mockResolvedValueOnce("ok");
    const { runGhApi } = await import("./gh.js");
    await runGhApi(["repos/o/r/pulls/1"]);
    await runGhApi(["repos/o/r/pulls/2"]);

    expect(mockExec).toHaveBeenCalledTimes(3);
    const plain = mockExec.mock.calls[0]![0] as { args: readonly string[] };
    expect(plain.args).toEqual(["api", "repos/o/r/pulls/1"]);
    const flagged = mockExec.mock.calls[1]![0] as { args: readonly string[] };
    expect(flagged.args).toEqual(["api", "--allow-escape-sequences", "repos/o/r/pulls/1"]);
    const memoized = mockExec.mock.calls[2]![0] as { args: readonly string[] };
    expect(memoized.args).toEqual(["api", "--allow-escape-sequences", "repos/o/r/pulls/2"]);
  });

  it("a plain success makes no flag attempt — an old gh never sees the flag", async () => {
    const { runGhApi } = await import("./gh.js");
    await runGhApi(["repos/o/r/pulls/1"]);

    expect(mockExec).toHaveBeenCalledTimes(1);
    const call = mockExec.mock.calls[0]![0] as { args: readonly string[] };
    expect(call.args).toEqual(["api", "repos/o/r/pulls/1"]);
  });

  it("propagates an error that is not the escape refusal", async () => {
    mockExec.mockRejectedValueOnce(new Error("gh: Not Found (HTTP 404)"));
    const { runGhApi } = await import("./gh.js");

    await expect(runGhApi(["repos/o/r/pulls/1"])).rejects.toThrow("HTTP 404");
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("never replays a write call on refusal — the write may already have landed", async () => {
    mockExec.mockRejectedValueOnce(
      new Error(
        "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway",
      ),
    );
    const { runGhApi } = await import("./gh.js");

    await expect(runGhApi(["repos/o/r/pulls/42/reviews", "--input", "-"], "{}")).rejects.toThrow(
      "escape sequences",
    );
    expect(mockExec).toHaveBeenCalledTimes(1);
    const only = mockExec.mock.calls[0]![0] as { args: readonly string[] };
    expect(only.args).toEqual(["api", "repos/o/r/pulls/42/reviews", "--input", "-"]);
  });
});
