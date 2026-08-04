import { describe, it, expect } from "vitest";
import { deriveModelHost, parseExtraEndpoints, buildSandboxConfig } from "./sandbox.js";

describe("deriveModelHost", () => {
  it("strips scheme, path, and port to a bare hostname", () => {
    expect(deriveModelHost("https://api.deepseek.com/anthropic")).toBe("api.deepseek.com");
    expect(deriveModelHost("https://api.anthropic.com")).toBe("api.anthropic.com");
    expect(deriveModelHost("https://gw.example.com:8443/v1/messages")).toBe("gw.example.com");
  });

  it("throws on a value that is not a parseable URL", () => {
    expect(() => deriveModelHost("api.deepseek.com")).toThrow(/could not derive the model host/);
    expect(() => deriveModelHost("")).toThrow(/could not derive the model host/);
  });
});

describe("parseExtraEndpoints", () => {
  it("splits on any whitespace and drops empty tokens", () => {
    expect(parseExtraEndpoints("pypi.org:443  files.pythonhosted.org:443")).toEqual([
      "pypi.org",
      "files.pythonhosted.org",
    ]);
    expect(parseExtraEndpoints("")).toEqual([]);
    expect(parseExtraEndpoints("   ")).toEqual([]);
  });

  it("drops a trailing :port but keeps the hostname", () => {
    expect(parseExtraEndpoints("cache.nixos.org:443")).toEqual(["cache.nixos.org"]);
    expect(parseExtraEndpoints("registry.internal")).toEqual(["registry.internal"]);
  });
});

describe("buildSandboxConfig", () => {
  it("allows the model host, GitHub, and the consumer's extras, deduped", () => {
    const config = buildSandboxConfig({
      apiBaseUrl: "https://api.deepseek.com/anthropic",
      extra: "pypi.org:443 files.pythonhosted.org:443",
    });
    expect(config.network.allowedDomains).toEqual([
      "api.deepseek.com",
      "api.github.com",
      "github.com",
      "pypi.org",
      "files.pythonhosted.org",
    ]);
    expect(config.network.deniedDomains).toEqual([]);
  });

  it("deduplicates a model host that repeats an extra", () => {
    const config = buildSandboxConfig({
      apiBaseUrl: "https://api.github.com/anthropic",
      extra: "github.com:443",
    });
    expect(config.network.allowedDomains).toEqual(["api.github.com", "github.com"]);
  });

  it("needs no extras — the model host and GitHub are always present", () => {
    const config = buildSandboxConfig({ apiBaseUrl: "https://api.anthropic.com" });
    expect(config.network.allowedDomains).toEqual([
      "api.anthropic.com",
      "api.github.com",
      "github.com",
    ]);
  });

  it("disables filesystem isolation (network-only jail)", () => {
    const config = buildSandboxConfig({ apiBaseUrl: "https://api.deepseek.com" });
    expect(config.filesystem).toEqual({
      allowRead: [],
      denyRead: [],
      allowWrite: ["/"],
      denyWrite: [],
    });
  });
});
