import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { adapt, isAdapterName } from "./adapt.js";
import { ResultEnvelopeCodec } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "..",
  "test",
  "fixtures",
  "native-claude-code-envelope.json",
);
const nativeFixture: unknown = JSON.parse(readFileSync(fixturePath, "utf-8"));

const ladderFixtureDir = resolve(__dirname, "..", "test", "fixtures", "extract-ladder");
const ladderFixturePath = (name: string): string => resolve(ladderFixtureDir, name);
const loadLadderFixture = (name: string): unknown =>
  JSON.parse(readFileSync(ladderFixturePath(name), "utf-8"));

describe("isAdapterName", () => {
  it("accepts claude-code", () => {
    expect(isAdapterName("claude-code")).toBe(true);
  });

  it("rejects unknown adapter names", () => {
    expect(isAdapterName("opencode")).toBe(false);
    expect(isAdapterName("")).toBe(false);
  });
});

describe("adapt — claude-code", () => {
  it("maps the native envelope onto the abstract envelope (round-trips through ResultEnvelopeCodec)", () => {
    const result = adapt("claude-code", nativeFixture);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;

    const decoded = ResultEnvelopeCodec.decode(result.right);
    expect(decoded._tag).toBe("Right");
  });

  it("maps modelUsage entries to the abstract models[] array", () => {
    const result = adapt("claude-code", nativeFixture);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;

    const pro = result.right.models.find((m) => m.model === "deepseek-v4-pro");
    expect(pro).toEqual({
      model: "deepseek-v4-pro",
      input_tokens: 84201,
      output_tokens: 6540,
      cache_read_tokens: 61020,
      cache_write_tokens: 0,
    });

    const flash = result.right.models.find((m) => m.model === "deepseek-v4-flash");
    expect(flash).toEqual({
      model: "deepseek-v4-flash",
      input_tokens: 12880,
      output_tokens: 1110,
      cache_read_tokens: 0,
    });
    expect(flash).not.toHaveProperty("cache_write_tokens");
  });

  it("maps turns from num_turns and duration_ms unchanged", () => {
    const result = adapt("claude-code", nativeFixture);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.turns).toBe(9);
    expect(result.right.duration_ms).toBe(87000);
  });

  it("maps vendor_cost_usd from total_cost_usd", () => {
    const result = adapt("claude-code", nativeFixture);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.vendor_cost_usd).toBe(0.0421);
  });

  it("maps vendor_cost_usd to null when total_cost_usd is absent", () => {
    const native = { ...(nativeFixture as Record<string, unknown>) };
    delete native["total_cost_usd"];
    const result = adapt("claude-code", native);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.vendor_cost_usd).toBeNull();
  });

  it("carries findings through from structured_output", () => {
    const result = adapt("claude-code", nativeFixture);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.findings.findings).toHaveLength(1);
    expect(result.right.findings.findings[0]!.title).toContain("timeout type changed");
  });

  it("takes schema_version from structured_output.schema_version", () => {
    const result = adapt("claude-code", nativeFixture);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.schema_version).toBe("0.2.0");
    expect(result.right.findings.schema_version).toBe("0.2.0");
  });

  it("defaults schema_version to 0.2.0 when structured_output omits it", () => {
    const native = JSON.parse(JSON.stringify(nativeFixture)) as {
      structured_output: Record<string, unknown>;
    };
    delete native.structured_output["schema_version"];
    const result = adapt("claude-code", native);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.schema_version).toBe("0.2.0");
    expect(result.right.findings.schema_version).toBe("0.2.0");
  });

  it("returns Left when structured_output does not conform to the findings schema", () => {
    const native = JSON.parse(JSON.stringify(nativeFixture)) as {
      structured_output: unknown;
    };
    native.structured_output = { not: "findings shaped" };
    const result = adapt("claude-code", native);
    expect(result._tag).toBe("Left");
  });

  it("returns Left when the native envelope does not match the Claude Code output shape", () => {
    const result = adapt("claude-code", { totally: "wrong shape" });
    expect(result._tag).toBe("Left");
  });

  it("returns Left when the ladder recovers nothing (structured_output absent, prose-only result)", () => {
    const result = adapt("claude-code", loadLadderFixture("f08-prose-only.json"));
    expect(result._tag).toBe("Left");
  });
});

describe("adapt — claude-code — extraction ladder integration", () => {
  it("recovers findings via a fenced block when structured_output is absent — envelope fields still come from the native envelope", () => {
    const result = adapt("claude-code", loadLadderFixture("f03-fenced-json.json"));
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;

    expect(result.right.findings.summary).toBe("Adds input validation to the upload handler.");
    expect(result.right.turns).toBe(3);
    expect(result.right.duration_ms).toBe(15230);
    expect(result.right.vendor_cost_usd).toBe(0.05);
    expect(result.right.models).toEqual([
      {
        model: "deepseek-v4-pro",
        input_tokens: 9000,
        output_tokens: 700,
        cache_read_tokens: 4000,
        cache_write_tokens: 0,
      },
    ]);
  });

  it("--agent-file wins over a disagreeing fenced block; envelope fields still come from the native envelope", () => {
    const result = adapt(
      "claude-code",
      loadLadderFixture("f11-agent-file-wins.json"),
      ladderFixturePath("f11-agent-file.json"),
    );
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;

    expect(result.right.findings.summary).toBe("Authoritative: from the agent-written file.");
    // f11's native envelope never overrides these — they must come from the baseline envelope,
    // not from anything on the agent-written file.
    expect(result.right.turns).toBe(2);
    expect(result.right.duration_ms).toBe(8123);
  });

  it("without --agent-file, the same native envelope falls back to the (differing) fenced block", () => {
    const result = adapt("claude-code", loadLadderFixture("f11-agent-file-wins.json"));
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.findings.summary).toBe("No issues found — the change looks safe to merge.");
  });

  it("REGRESSION: --agent-file wins over a disagreeing structured_output, not just a disagreeing fence", () => {
    const native = {
      modelUsage: {
        "deepseek-v4-pro": { inputTokens: 100, outputTokens: 50 },
      },
      num_turns: 1,
      duration_ms: 1000,
      structured_output: {
        schema_version: "0.2.0",
        summary: "from structured_output — must lose to the agent file",
        verdict: "approve",
        findings: [],
      },
    };
    const result = adapt("claude-code", native, ladderFixturePath("f11-agent-file.json"));
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.findings.summary).toBe("Authoritative: from the agent-written file.");
  });
});

describe("adapt — run metadata (route/effort)", () => {
  it("stamps route and effort into the envelope when provided", () => {
    const result = adapt("claude-code", nativeFixture, undefined, {
      route: "full review",
      effort: "max",
    });
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.route).toBe("full review");
    expect(result.right.effort).toBe("max");
  });

  it("omits route and effort when no metadata is provided", () => {
    const result = adapt("claude-code", nativeFixture);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.route).toBeUndefined();
    expect(result.right.effort).toBeUndefined();
  });
});
