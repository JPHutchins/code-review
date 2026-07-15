import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { adapt, isAdapterName } from "./adapt.js";
import { ResultEnvelopeCodec, DEFAULT_SCHEMA_VERSION } from "./schema.js";

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
    expect(result.right.schema_version).toBe("0.4.0");
    expect(result.right.findings.schema_version).toBe("0.4.0");
  });

  it("defaults schema_version to DEFAULT_SCHEMA_VERSION when structured_output omits it", () => {
    const native = JSON.parse(JSON.stringify(nativeFixture)) as {
      structured_output: Record<string, unknown>;
    };
    delete native.structured_output["schema_version"];
    const result = adapt("claude-code", native);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.schema_version).toBe(DEFAULT_SCHEMA_VERSION);
    expect(result.right.findings.schema_version).toBe(DEFAULT_SCHEMA_VERSION);
  });

  it("returns Right with empty findings and real telemetry when structured_output does not conform to the findings schema (issue #18)", () => {
    const native = JSON.parse(JSON.stringify(nativeFixture)) as {
      structured_output: unknown;
    };
    native.structured_output = { not: "findings shaped" };
    const result = adapt("claude-code", native);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.findings.findings).toEqual([]);
    expect(result.right.findings.summary).toContain("did not complete");
    // Telemetry survives the ladder miss — it comes from the native envelope unconditionally.
    expect(result.right.turns).toBe(9);
    expect(result.right.duration_ms).toBe(87000);
    expect(result.right.models.length).toBeGreaterThan(0);
  });

  it("returns Left when the native envelope does not match the Claude Code output shape", () => {
    const result = adapt("claude-code", { totally: "wrong shape" });
    expect(result._tag).toBe("Left");
  });

  it("returns Right with empty findings and real telemetry when the ladder recovers nothing (structured_output absent, prose-only result) — issue #18", () => {
    const result = adapt("claude-code", loadLadderFixture("f08-prose-only.json"));
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.findings.findings).toEqual([]);
    expect(result.right.findings.verdict).toBe("comment");
    expect(result.right.findings.summary).toContain("did not complete");
    // Real telemetry from the native envelope survives the ladder miss (issue #18) — this is the
    // ladder-miss-WITH-usage regression test: no findings, but the run's actual usage is not lost.
    expect(result.right.turns).toBe(2);
    expect(result.right.duration_ms).toBe(8123);
    expect(result.right.vendor_cost_usd).toBe(0.0123);
    expect(result.right.models).toEqual([
      {
        model: "deepseek-v4-pro",
        input_tokens: 512,
        output_tokens: 340,
        cache_read_tokens: 1200,
        cache_write_tokens: 0,
      },
    ]);
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
        schema_version: "0.4.0",
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

describe("adapt — claude-code — absent native envelope (issue #39)", () => {
  it("degrades to a no-telemetry 'did not complete' envelope instead of failing when the native envelope is absent (a timeout-killed, empty/truncated envelope.json)", () => {
    const result = adapt("claude-code", undefined);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    // Degenerate telemetry — nothing to report, but the run does not crash.
    expect(result.right.models).toEqual([]);
    expect(result.right.turns).toBe(0);
    expect(result.right.duration_ms).toBe(0);
    expect(result.right.vendor_cost_usd).toBeNull();
    // No findings recoverable → the graceful notice, not a thrown/exited process.
    expect(result.right.findings.findings).toEqual([]);
    expect(result.right.findings.verdict).toBe("comment");
    expect(result.right.findings.summary).toContain("did not complete");
    // The whole envelope still round-trips through the abstract codec.
    expect(ResultEnvelopeCodec.decode(result.right)._tag).toBe("Right");
  });

  it("treats a literal JSON null native the same as absent (degrades, never a hard Left)", () => {
    const result = adapt("claude-code", null);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.models).toEqual([]);
    expect(result.right.findings.summary).toContain("did not complete");
  });

  it("still recovers findings from --agent-file when the native envelope is absent — a checkpointed $DRAFT survives the cutoff", () => {
    const result = adapt("claude-code", undefined, ladderFixturePath("f11-agent-file.json"));
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    // The agent-file rung needs no native envelope, so the review is saved even with none.
    expect(result.right.findings.summary).toBe("Authoritative: from the agent-written file.");
    // Telemetry is still degenerate — cost/turns are unknown without a native envelope (#36 refills).
    expect(result.right.models).toEqual([]);
    expect(result.right.turns).toBe(0);
    expect(result.right.vendor_cost_usd).toBeNull();
  });

  it("recovers findings from the last-valid fallback when the native is absent and --agent-file is invalid (a wall-kill truncated the live draft)", () => {
    const result = adapt("claude-code", undefined, ladderFixturePath("f08-prose-only.json"), {
      agentFileFallbackPath: ladderFixturePath("f11-agent-file.json"),
    });
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.findings.summary).toBe("Authoritative: from the agent-written file.");
  });

  it("prefers a valid --agent-file over the last-valid fallback", () => {
    const result = adapt("claude-code", undefined, ladderFixturePath("f11-agent-file.json"), {
      agentFileFallbackPath: ladderFixturePath("f08-prose-only.json"),
    });
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.findings.summary).toBe("Authoritative: from the agent-written file.");
  });

  it("stamps route/effort onto the degraded envelope when the native envelope is absent", () => {
    const result = adapt("claude-code", undefined, undefined, {
      route: "full review",
      effort: "xhigh",
    });
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.route).toBe("full review");
    expect(result.right.effort).toBe("xhigh");
    expect(result.right.turns).toBe(0);
  });
});

describe("adapt — transcript telemetry fallback (issue #36 — real cost on a wall kill)", () => {
  const fallback = {
    models: [
      {
        model: "deepseek-v4-pro",
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 50,
        cache_write_tokens: 0,
      },
    ],
    turns: 7,
    durationMs: 123456,
  };

  it("refills telemetry from the transcript fallback when the native envelope is absent — cost is real, not $0.00", () => {
    const result = adapt("claude-code", undefined, undefined, {
      transcriptFallback: () => fallback,
    });
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.models).toEqual(fallback.models);
    expect(result.right.turns).toBe(7);
    expect(result.right.duration_ms).toBe(123456);
    expect(result.right.vendor_cost_usd).toBeNull();
    // Findings are still the graceful notice (no --agent-file here) — telemetry is what changed.
    expect(result.right.findings.summary).toContain("did not complete");
    expect(ResultEnvelopeCodec.decode(result.right)._tag).toBe("Right");
  });

  it("does not refill from an EMPTY transcript fallback (stays degenerate, never fabricates models)", () => {
    const result = adapt("claude-code", undefined, undefined, {
      transcriptFallback: () => ({ models: [], turns: 0, durationMs: 0 }),
    });
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.models).toEqual([]);
    expect(result.right.turns).toBe(0);
  });

  it("keeps native per-model USAGE but takes wall + turns from the transcript when both are present (issue #59)", () => {
    const result = adapt("claude-code", nativeFixture, undefined, {
      transcriptFallback: () => fallback,
    });
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    // Usage stays native-authoritative — deepseek-v4-flash exists only in the native fixture, and the
    // pro counts are the native's (6540 output), NOT the fallback's (200) — proving usage isn't taken
    // from the transcript (which under-counts output).
    expect(result.right.models.some((m) => m.model === "deepseek-v4-flash")).toBe(true);
    expect(result.right.models.find((m) => m.model === "deepseek-v4-pro")?.output_tokens).toBe(
      6540,
    );
    // ...but wall + turns come from the transcript, since the native under-reports a subagent fan-out.
    expect(result.right.turns).toBe(7);
    expect(result.right.duration_ms).toBe(123456);
  });

  it("invokes the fallback thunk whenever a transcript is supplied — wall + turns need it, native usage or not (issue #59)", () => {
    let calledWithNative = 0;
    adapt("claude-code", nativeFixture, undefined, {
      transcriptFallback: () => {
        calledWithNative++;
        return fallback;
      },
    });
    expect(calledWithNative).toBe(1);

    let calledWhenAbsent = 0;
    adapt("claude-code", undefined, undefined, {
      transcriptFallback: () => {
        calledWhenAbsent++;
        return fallback;
      },
    });
    expect(calledWhenAbsent).toBe(1);
  });

  it("recovers findings from --agent-file AND refills telemetry from the fallback (both survive a wall kill)", () => {
    const result = adapt("claude-code", undefined, ladderFixturePath("f11-agent-file.json"), {
      transcriptFallback: () => fallback,
    });
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.findings.summary).toBe("Authoritative: from the agent-written file.");
    expect(result.right.turns).toBe(7);
    expect(result.right.models).toEqual(fallback.models);
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
