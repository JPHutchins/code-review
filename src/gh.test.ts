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

// The escape-flag boundary: newer gh refuses raw responses carrying terminal escapes, older gh
// rejects the flag itself — runGhApi probes once per process and only then passes the flag.
describe("runGhApi — the escape-flag boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    mockExec.mockReset();
    mockExec.mockResolvedValue("");
  });

  it("probes once with zen, then passes --allow-escape-sequences on every call", async () => {
    const { runGhApi } = await import("./gh.js");
    await runGhApi(["repos/o/r/pulls/1"]);
    await runGhApi(["repos/o/r/pulls/2"]);

    // One zen probe + two api calls.
    expect(mockExec).toHaveBeenCalledTimes(3);
    const probe = mockExec.mock.calls[0]![0] as { args: readonly string[] };
    expect(probe.args).toEqual(["api", "zen", "--allow-escape-sequences"]);
    const first = mockExec.mock.calls[1]![0] as { args: readonly string[] };
    expect(first.args).toEqual(["api", "--allow-escape-sequences", "repos/o/r/pulls/1"]);
  });

  it("omits the flag when the gh predates it (the probe's failure is 'unknown flag')", async () => {
    mockExec.mockRejectedValueOnce(new Error("unknown flag: --allow-escape-sequences"));
    const { runGhApi } = await import("./gh.js");
    await runGhApi(["repos/o/r/pulls/1"]);

    const call = mockExec.mock.calls[1]![0] as { args: readonly string[] };
    expect(call.args).toEqual(["api", "repos/o/r/pulls/1"]);
  });

  it("omits the flag when the probe is unreachable — a false positive would break old gh", async () => {
    mockExec.mockRejectedValueOnce(new Error("could not resolve host"));
    const { runGhApi } = await import("./gh.js");
    await runGhApi(["repos/o/r/pulls/1"]);

    const call = mockExec.mock.calls[1]![0] as { args: readonly string[] };
    expect(call.args).toEqual(["api", "repos/o/r/pulls/1"]);
  });
});
