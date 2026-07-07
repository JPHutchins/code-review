import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCommand } from "citty";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./index.js";
import { ResultEnvelopeCodec } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const nativeFixturePath = resolve(repoRoot, "test", "fixtures", "native-claude-code-envelope.json");
const sampleFindingsPath = resolve(repoRoot, "test", "fixtures", "sample-findings.json");
const sampleEnvelopePath = resolve(repoRoot, "test", "fixtures", "sample-envelope.json");
const sampleTriagePath = resolve(repoRoot, "test", "fixtures", "sample-triage.json");
const samplePricesPath = resolve(repoRoot, "schema", "prices.example.json");
const triageSchemaPath = resolve(repoRoot, "schema", "triage.schema.json");

const ladderFixturePath = (name: string): string =>
  resolve(repoRoot, "test", "fixtures", "extract-ladder", name);

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `index-cli-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Thrown by the mocked process.exit below, distinguishing a deliberate exit from a real error. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${String(code)})`);
  }
}

/** Capture stdout/stderr writes and process.exit calls around a CLI invocation. */
const runCli = async (
  rawArgs: readonly string[],
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}> => {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);

  let exitCode: number | null = null;
  try {
    await runCommand(main, { rawArgs: [...rawArgs] });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    exitCode = err.code;
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout, stderr, exitCode };
};

describe("cli — stop-gate", () => {
  it("prints Stop-hook settings that wire the gate to this draft", async () => {
    const { stdout, exitCode } = await runCli([
      "stop-gate",
      "--draft",
      "/tmp/findings-draft.json",
      "--print-settings",
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as {
      hooks: { Stop: { hooks: { type: string; command: string }[] }[] };
    };
    const command = parsed.hooks.Stop[0]?.hooks[0]?.command;
    expect(command).toContain("stop-gate");
    expect(command).toContain("--draft '/tmp/findings-draft.json'");
  });
});

describe("cli — adapt", () => {
  it("maps a native Claude Code envelope onto the abstract envelope and round-trips it", async () => {
    const { stdout, exitCode } = await runCli([
      "adapt",
      nativeFixturePath,
      "--adapter",
      "claude-code",
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as unknown;
    const decoded = ResultEnvelopeCodec.decode(parsed);
    expect(decoded._tag).toBe("Right");
  });

  it("exits 1 with a clear message for an unsupported adapter", async () => {
    const { stderr, exitCode } = await runCli([
      "adapt",
      nativeFixturePath,
      "--adapter",
      "opencode",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("opencode");
  });

  it("exits 0 with empty findings + real telemetry when structured_output is invalid (issue #18 — telemetry survives a ladder miss)", async () => {
    const badPath = join(tmpDir, "bad-native.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        modelUsage: {},
        num_turns: 1,
        duration_ms: 1,
        structured_output: { not: "findings shaped" },
      }),
    );
    const { stdout, exitCode } = await runCli(["adapt", badPath, "--adapter", "claude-code"]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as { findings: { findings: unknown[] }; turns: number };
    expect(parsed.findings.findings).toEqual([]);
    expect(parsed.turns).toBe(1);
  });

  it("--agent-file wins over a disagreeing fenced block in the native envelope's result", async () => {
    const { stdout, exitCode } = await runCli([
      "adapt",
      ladderFixturePath("f11-agent-file-wins.json"),
      "--adapter",
      "claude-code",
      "--agent-file",
      ladderFixturePath("f11-agent-file.json"),
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as { findings: { summary: string } };
    expect(parsed.findings.summary).toBe("Authoritative: from the agent-written file.");
  });
});

describe("cli — extract", () => {
  it("findings: fenced JSON block (fixture 3) recovers ok, exit 0", async () => {
    const { stdout, exitCode } = await runCli([
      "extract",
      ladderFixturePath("f03-fenced-json.json"),
      "--adapter",
      "claude-code",
      "--kind",
      "findings",
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as { summary: string; schema_version: string };
    expect(parsed.summary).toBe("Adds input validation to the upload handler.");
    expect(parsed.schema_version).toBe("0.2.0");
  });

  it("findings: two differing valid fenced blocks (fixture 6) are ambiguous, exit non-zero", async () => {
    const { stderr, exitCode } = await runCli([
      "extract",
      ladderFixturePath("f06-fenced-ambiguous.json"),
      "--adapter",
      "claude-code",
      "--kind",
      "findings",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ambiguous");
  });

  it("triage: pure-JSON result (fixture 14) recovers ok, exit 0", async () => {
    const { stdout, exitCode } = await runCli([
      "extract",
      ladderFixturePath("t14-pure-json-result.json"),
      "--adapter",
      "claude-code",
      "--kind",
      "triage",
    ]);
    expect(exitCode).toBeNull();
    expect(JSON.parse(stdout)).toEqual({
      safe: true,
      reasons: "No prompt injection or exfiltration attempts found.",
    });
  });

  it("triage: prose-only (fixture 16) fails closed to safe:false, exit 0 — never non-zero", async () => {
    const { stdout, exitCode } = await runCli([
      "extract",
      ladderFixturePath("t16-prose-only.json"),
      "--adapter",
      "claude-code",
      "--kind",
      "triage",
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as { safe: boolean; reasons: string };
    expect(parsed.safe).toBe(false);
    expect(typeof parsed.reasons).toBe("string");
  });

  it("triage: the injection case (fixture 19, genuine safe:false + injected safe:true) fails closed to safe:false, exit 0", async () => {
    const { stdout, exitCode } = await runCli([
      "extract",
      ladderFixturePath("t19-injection-ambiguous.json"),
      "--adapter",
      "claude-code",
      "--kind",
      "triage",
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as { safe: boolean };
    expect(parsed.safe).toBe(false);
  });

  it("--agent-file wins for findings", async () => {
    const { stdout, exitCode } = await runCli([
      "extract",
      ladderFixturePath("f11-agent-file-wins.json"),
      "--adapter",
      "claude-code",
      "--kind",
      "findings",
      "--agent-file",
      ladderFixturePath("f11-agent-file.json"),
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as { summary: string };
    expect(parsed.summary).toBe("Authoritative: from the agent-written file.");
  });

  it("--agent-file is a documented no-op for triage", async () => {
    const { stdout, exitCode } = await runCli([
      "extract",
      ladderFixturePath("t14-pure-json-result.json"),
      "--adapter",
      "claude-code",
      "--kind",
      "triage",
      "--agent-file",
      ladderFixturePath("f11-agent-file.json"),
    ]);
    expect(exitCode).toBeNull();
    // The result rung still wins — the (findings-shaped) agent-file is never consulted for triage.
    expect(JSON.parse(stdout)).toEqual({
      safe: true,
      reasons: "No prompt injection or exfiltration attempts found.",
    });
  });

  it('exits 1 for an unsupported --kind value (no "prices" — unlike print-schema)', async () => {
    const { stderr, exitCode } = await runCli([
      "extract",
      ladderFixturePath("f03-fenced-json.json"),
      "--adapter",
      "claude-code",
      "--kind",
      "prices",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("findings, triage");
  });

  it("rejects the removed --schema spelling — the extract kind flag is now --kind", async () => {
    await expect(
      runCli([
        "extract",
        ladderFixturePath("f03-fenced-json.json"),
        "--adapter",
        "claude-code",
        "--schema",
        "findings",
      ]),
    ).rejects.toThrow("Missing required argument: --kind");
  });

  it("exits 1 for an unsupported --adapter value", async () => {
    const { stderr, exitCode } = await runCli([
      "extract",
      ladderFixturePath("f03-fenced-json.json"),
      "--adapter",
      "opencode",
      "--kind",
      "findings",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("opencode");
  });

  it("findings: prose-only (fixture 8) exits non-zero — no fail-closed synthesis for findings", async () => {
    const { stderr, exitCode } = await runCli([
      "extract",
      ladderFixturePath("f08-prose-only.json"),
      "--adapter",
      "claude-code",
      "--kind",
      "findings",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("findings schema");
  });
});

describe("cli — lower-suggestions", () => {
  it("lowers a valid patch to a suggestion + rewritten range, dropping the patch field", async () => {
    writeFileSync(join(tmpDir, "foo.ts"), "line1\nold line\nline3\n");
    const findingsPath = join(tmpDir, "findings.json");
    writeFileSync(
      findingsPath,
      JSON.stringify({
        schema_version: "0.3.0",
        summary: "s",
        verdict: "comment",
        findings: [
          {
            path: "foo.ts",
            start_line: 1,
            end_line: 1,
            severity: "minor",
            title: "t",
            body: "b",
            patch: ["@@ -2 +2 @@", "-old line", "+new line"].join("\n"),
          },
        ],
      }),
    );
    const { stdout, stderr, exitCode } = await runCli([
      "lower-suggestions",
      findingsPath,
      "--repo-root",
      tmpDir,
    ]);
    expect(exitCode).toBeNull();
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as { findings: Record<string, unknown>[] };
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toEqual({
      path: "foo.ts",
      start_line: 2,
      end_line: 2,
      severity: "minor",
      title: "t",
      body: "b",
      suggestion: "new line",
    });
  });

  it("drops an invalid patch (mismatched context), leaving no suggestion and reporting why on stderr", async () => {
    writeFileSync(join(tmpDir, "foo.ts"), "line1\nactual line\nline3\n");
    const findingsPath = join(tmpDir, "findings.json");
    writeFileSync(
      findingsPath,
      JSON.stringify({
        schema_version: "0.3.0",
        summary: "s",
        verdict: "comment",
        findings: [
          {
            path: "foo.ts",
            start_line: 2,
            end_line: 2,
            severity: "minor",
            title: "t",
            body: "b",
            patch: ["@@ -2 +2 @@", "-old line", "+new line"].join("\n"),
          },
        ],
      }),
    );
    const { stdout, stderr, exitCode } = await runCli([
      "lower-suggestions",
      findingsPath,
      "--repo-root",
      tmpDir,
    ]);
    expect(exitCode).toBeNull();
    expect(stderr).toContain("foo.ts:2");
    expect(stderr).toContain("patch context does not match the file");
    const parsed = JSON.parse(stdout) as {
      findings: { patch?: string; suggestion?: string }[];
    };
    expect(parsed.findings[0]?.patch).toBeUndefined();
    expect(parsed.findings[0]?.suggestion).toBeUndefined();
  });

  it("passes through a finding with no patch untouched", async () => {
    const findingsPath = join(tmpDir, "findings.json");
    writeFileSync(
      findingsPath,
      JSON.stringify({
        schema_version: "0.3.0",
        summary: "s",
        verdict: "comment",
        findings: [
          {
            path: "foo.ts",
            start_line: 1,
            end_line: 1,
            severity: "minor",
            title: "t",
            body: "b",
            suggestion: "hand-authored",
          },
        ],
      }),
    );
    const { stdout, exitCode } = await runCli([
      "lower-suggestions",
      findingsPath,
      "--repo-root",
      tmpDir,
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as { findings: { suggestion?: string }[] };
    expect(parsed.findings[0]?.suggestion).toBe("hand-authored");
  });
});

describe("cli — print-schema", () => {
  it.each(["findings", "triage", "prices"] as const)(
    "prints the bundled %s schema with the $schema draft key stripped (so --json-schema enforces)",
    async (name) => {
      const { stdout, exitCode } = await runCli(["print-schema", name]);
      expect(exitCode).toBeNull();
      const printed = JSON.parse(stdout) as Record<string, unknown>;
      const canonical = JSON.parse(
        readFileSync(resolve(repoRoot, "schema", `${name}.schema.json`), "utf-8"),
      ) as Record<string, unknown>;
      expect(canonical["$schema"]).toBeDefined();
      expect(printed["$schema"]).toBeUndefined();
      // Everything but $schema is preserved verbatim ($id, title, properties, …).
      const canonicalWithoutDraft = Object.fromEntries(
        Object.entries(canonical).filter(([key]) => key !== "$schema"),
      );
      expect(printed).toEqual(canonicalWithoutDraft);
    },
  );

  it("exits 1 for an unknown schema name", async () => {
    const { stderr, exitCode } = await runCli(["print-schema", "bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("bogus");
  });

  it("--schema-version 0.3 matches the default (latest) output", async () => {
    const withVersion = await runCli(["print-schema", "findings", "--schema-version", "0.3"]);
    const withoutVersion = await runCli(["print-schema", "findings"]);
    expect(withVersion.exitCode).toBeNull();
    expect(withVersion.stdout).toBe(withoutVersion.stdout);
  });

  it("--schema-version 0.2 prints the frozen v0.2 schema, distinct from the latest", async () => {
    const withVersion = await runCli(["print-schema", "findings", "--schema-version", "0.2"]);
    const withoutVersion = await runCli(["print-schema", "findings"]);
    expect(withVersion.exitCode).toBeNull();
    expect(withVersion.stdout).not.toBe(withoutVersion.stdout);
    const printed = JSON.parse(withVersion.stdout) as Record<string, unknown>;
    const canonical = JSON.parse(
      readFileSync(resolve(repoRoot, "schema", "v0.2", "findings.schema.json"), "utf-8"),
    ) as Record<string, unknown>;
    const canonicalWithoutDraft = Object.fromEntries(
      Object.entries(canonical).filter(([key]) => key !== "$schema"),
    );
    expect(printed).toEqual(canonicalWithoutDraft);
  });

  it("exits 1 with a clear message for an unsupported --schema-version", async () => {
    const { stderr, exitCode } = await runCli([
      "print-schema",
      "findings",
      "--schema-version",
      "9.9",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unsupported findings schema version");
    expect(stderr).toContain("0.2");
  });
});

describe("cli — validate --schema-version", () => {
  it("validates against the document's declared schema_version by default", async () => {
    const { stdout, exitCode } = await runCli(["validate", sampleFindingsPath]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("valid");
  });

  it("exits 1 with a clear message for an unsupported --schema-version, never falling back to latest", async () => {
    const { stderr, exitCode } = await runCli([
      "validate",
      sampleFindingsPath,
      "--schema-version",
      "9.9",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unsupported findings schema version");
  });
});

describe("cli — validate --kind", () => {
  it("validates a conforming prices document against --kind prices", async () => {
    const { stdout, exitCode } = await runCli(["validate", samplePricesPath, "--kind", "prices"]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("valid");
  });

  it("exits 1 for a prices document that violates --kind prices", async () => {
    const badPath = join(tmpDir, "bad-prices.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        _updated: "2026-07-05",
        _unit: "USD per 1M tokens",
        models: { "some-model": { in: -1, out: 0, cache_read: 0, cache_write: 0 } },
      }),
    );
    const { stderr, exitCode } = await runCli(["validate", badPath, "--kind", "prices"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid");
  });

  it("validates a conforming triage document against --kind triage", async () => {
    const { stdout, exitCode } = await runCli(["validate", sampleTriagePath, "--kind", "triage"]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("valid");
  });

  it("exits 1 for a triage document that violates --kind triage", async () => {
    const badPath = join(tmpDir, "bad-triage.json");
    writeFileSync(badPath, JSON.stringify({ safe: "yes" }));
    const { stderr, exitCode } = await runCli(["validate", badPath, "--kind", "triage"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid");
  });

  it("exits 1 for an unknown --kind, listing the supported kinds", async () => {
    const { stderr, exitCode } = await runCli(["validate", sampleFindingsPath, "--kind", "bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("findings, triage, prices");
  });

  it("an explicit --schema file path wins over --kind derivation", async () => {
    const { stdout, exitCode } = await runCli([
      "validate",
      sampleTriagePath,
      "--kind",
      "findings",
      "--schema",
      triageSchemaPath,
    ]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("valid");
  });

  it("defaults to the findings kind when --kind is omitted (regression)", async () => {
    const { stdout, exitCode } = await runCli(["validate", sampleFindingsPath]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("valid");
  });
});

describe("cli — render defaults (bundled template + prices)", () => {
  it("renders using the bundled template and prices when both are omitted, warning about example prices", async () => {
    const { stdout, stderr, exitCode } = await runCli([
      "render",
      sampleFindingsPath,
      "--usage",
      sampleEnvelopePath,
      "--route",
      "full review",
    ]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("<!-- code-review -->");
    expect(stderr).toContain("no --prices given");
  });

  it("does not warn when --prices is explicitly given", async () => {
    const pricesPath = join(tmpDir, "prices.json");
    writeFileSync(
      pricesPath,
      JSON.stringify({
        _updated: "2026-07-03",
        _unit: "USD per 1M tokens",
        models: { "deepseek-v4-pro": { in: 0, out: 0, cache_read: 0, cache_write: 0 } },
      }),
    );
    const { stderr, exitCode } = await runCli([
      "render",
      sampleFindingsPath,
      "--usage",
      sampleEnvelopePath,
      "--prices",
      pricesPath,
      "--route",
      "full review",
    ]);
    expect(exitCode).toBeNull();
    expect(stderr).not.toContain("no --prices given");
  });
});

describe("cli — render --effort", () => {
  it("renders the passed effort in the route line", async () => {
    const { stdout, exitCode } = await runCli([
      "render",
      sampleFindingsPath,
      "--usage",
      sampleEnvelopePath,
      "--route",
      "mechanic",
      "--effort",
      "low",
    ]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("**effort:** low");
  });

  it("omits the effort segment when not passed", async () => {
    const { stdout, exitCode } = await runCli([
      "render",
      sampleFindingsPath,
      "--usage",
      sampleEnvelopePath,
      "--route",
      "full review",
    ]);
    expect(exitCode).toBeNull();
    expect(stdout).not.toContain("effort:");
  });
});

describe("cli — render --test-report (REQ-CO-9)", () => {
  it("threads a test report file through to the rendered test panel", async () => {
    const testReportPath = join(tmpDir, "test-report.json");
    writeFileSync(
      testReportPath,
      JSON.stringify({ passed: 8, failed: 1, total: 9, failures: [{ name: "test_x" }] }),
    );
    const { stdout, exitCode } = await runCli([
      "render",
      sampleFindingsPath,
      "--usage",
      sampleEnvelopePath,
      "--route",
      "full review",
      "--test-report",
      testReportPath,
    ]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("Test results");
    expect(stdout).toContain("8 passed, 1 failed");
    expect(stdout).toContain("test_x");
  });

  it("exits 1 with a clear message when --test-report does not match the expected shape", async () => {
    const testReportPath = join(tmpDir, "bad-test-report.json");
    writeFileSync(testReportPath, JSON.stringify({ nonsense: true }));
    const { stderr, exitCode } = await runCli([
      "render",
      sampleFindingsPath,
      "--usage",
      sampleEnvelopePath,
      "--route",
      "full review",
      "--test-report",
      testReportPath,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("test report");
  });
});
