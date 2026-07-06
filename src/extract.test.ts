import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractStructured,
  scanFencedBlocks,
  withDefaultSchemaVersion,
  describeLadderFailure,
  ladderFailureDiagnostics,
} from "./extract.js";
import type { ExtractKind, LadderOutcome } from "./extract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolvePath(__dirname, "..", "test", "fixtures", "extract-ladder");

const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixtureDir, name), "utf-8")) as unknown;

const fixturePath = (name: string): string => join(fixtureDir, name);

const extractFixture = (kind: ExtractKind, name: string, agentFilePath?: string): LadderOutcome =>
  extractStructured({ kind, native: loadFixture(name), agentFilePath });

interface Case {
  readonly name: string;
  readonly kind: ExtractKind;
  readonly fixture: string;
  readonly expected: LadderOutcome["kind"];
}

const cases: readonly Case[] = [
  {
    name: "1 structured-output-present",
    kind: "findings",
    fixture: "f01-structured-output.json",
    expected: "ok",
  },
  {
    name: "2 pure-json-result",
    kind: "findings",
    fixture: "f02-pure-json-result.json",
    expected: "ok",
  },
  {
    name: "3 fenced-json (real case)",
    kind: "findings",
    fixture: "f03-fenced-json.json",
    expected: "ok",
  },
  { name: "4 fenced-bare", kind: "findings", fixture: "f04-fenced-bare.json", expected: "ok" },
  {
    name: "5 fenced-invalid-then-valid",
    kind: "findings",
    fixture: "f05-fenced-invalid-then-valid.json",
    expected: "ok",
  },
  {
    name: "6 fenced-valid-then-valid-differing",
    kind: "findings",
    fixture: "f06-fenced-ambiguous.json",
    expected: "ambiguous",
  },
  {
    name: "7 schema-violating",
    kind: "findings",
    fixture: "f07-schema-violating.json",
    expected: "none",
  },
  { name: "8 prose-only", kind: "findings", fixture: "f08-prose-only.json", expected: "none" },
  {
    name: "9 error-envelope (may carry a valid fence)",
    kind: "findings",
    fixture: "f09-error-envelope.json",
    expected: "error-envelope",
  },
  {
    name: "10 trailing-text-after-fence",
    kind: "findings",
    fixture: "f10-trailing-text-after-fence.json",
    expected: "ok",
  },
  {
    name: "12 schema_version-omitted",
    kind: "findings",
    fixture: "f12-schema-version-omitted.json",
    expected: "ok",
  },
  {
    name: "13 triage structured-output",
    kind: "triage",
    fixture: "t13-structured-output.json",
    expected: "ok",
  },
  {
    name: "14 triage pure-json-result",
    kind: "triage",
    fixture: "t14-pure-json-result.json",
    expected: "ok",
  },
  { name: "15 triage fenced", kind: "triage", fixture: "t15-fenced.json", expected: "ok" },
  {
    name: "16 triage prose-only",
    kind: "triage",
    fixture: "t16-prose-only.json",
    expected: "none",
  },
  {
    name: "17 triage schema-violating",
    kind: "triage",
    fixture: "t17-schema-violating.json",
    expected: "none",
  },
  {
    name: "18 triage error-envelope",
    kind: "triage",
    fixture: "t18-error-envelope.json",
    expected: "error-envelope",
  },
  {
    name: "19 triage injection-two-valid",
    kind: "triage",
    fixture: "t19-injection-ambiguous.json",
    expected: "ambiguous",
  },
  {
    name: "20 fenced-duplicate (dedup ruling)",
    kind: "findings",
    fixture: "f20-fenced-duplicate.json",
    expected: "ok",
  },
  {
    name: "21 triage fenced-duplicate (dedup ruling)",
    kind: "triage",
    fixture: "t21-fenced-duplicate.json",
    expected: "ok",
  },
];

describe("extractStructured — fixture matrix", () => {
  it.each(cases)("$name → $expected", ({ kind, fixture, expected }) => {
    const outcome = extractFixture(kind, fixture);
    expect(outcome.kind).toBe(expected);
  });
});

describe("extractStructured — rung order (ruling 1)", () => {
  it("--agent-file wins over a disagreeing fenced block (11)", () => {
    const outcome = extractFixture(
      "findings",
      "f11-agent-file-wins.json",
      fixturePath("f11-agent-file.json"),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const candidate = outcome.candidate as { summary: string };
    expect(candidate.summary).toBe("Authoritative: from the agent-written file.");
  });

  it("--agent-file present but invalid falls through to the next rung", () => {
    const native = loadFixture("f03-fenced-json.json");
    const outcome = extractStructured({
      kind: "findings",
      native,
      agentFilePath: fixturePath("f08-prose-only.json"), // not JSON at all — parse failure
    });
    expect(outcome.kind).toBe("ok");
  });

  it("--agent-file is a documented no-op for triage — a valid file does not override the ladder", () => {
    const outcome = extractStructured({
      kind: "triage",
      native: loadFixture("t16-prose-only.json"),
      agentFilePath: fixturePath("f11-agent-file.json"), // valid findings JSON, irrelevant to triage
    });
    expect(outcome.kind).toBe("none");
  });

  it("structured_output wins over a pure-JSON result when both validate", () => {
    const native = {
      ...(loadFixture("f02-pure-json-result.json") as Record<string, unknown>),
      structured_output: {
        schema_version: "0.2.0",
        summary: "from structured_output",
        verdict: "approve",
        findings: [],
      },
    };
    const outcome = extractStructured({ kind: "findings", native });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect((outcome.candidate as { summary: string }).summary).toBe("from structured_output");
  });

  it("REGRESSION: --agent-file wins over a disagreeing structured_output, not just a disagreeing fence", () => {
    const native = {
      structured_output: {
        schema_version: "0.2.0",
        summary: "from structured_output — must lose to the agent file",
        verdict: "approve",
        findings: [],
      },
    };
    const outcome = extractStructured({
      kind: "findings",
      native,
      agentFilePath: fixturePath("f11-agent-file.json"),
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect((outcome.candidate as { summary: string }).summary).toBe(
      "Authoritative: from the agent-written file.",
    );
  });
});

describe("extractStructured — error-envelope short-circuit (ruling 2)", () => {
  it("is_error:true short-circuits even when structured_output itself validates", () => {
    const native = {
      is_error: true,
      subtype: "error_max_turns",
      structured_output: {
        schema_version: "0.2.0",
        summary: "s",
        verdict: "comment",
        findings: [],
      },
    };
    const outcome = extractStructured({ kind: "findings", native });
    expect(outcome.kind).toBe("error-envelope");
  });

  it("a non-success subtype short-circuits even without is_error set", () => {
    const native = {
      subtype: "error_during_execution",
      structured_output: {
        schema_version: "0.2.0",
        summary: "s",
        verdict: "comment",
        findings: [],
      },
    };
    expect(extractStructured({ kind: "findings", native }).kind).toBe("error-envelope");
  });

  it("a non-null api_error_status short-circuits", () => {
    const native = { api_error_status: 529, result: JSON.stringify({ safe: true, reasons: "r" }) };
    expect(extractStructured({ kind: "triage", native }).kind).toBe("error-envelope");
  });

  it('subtype:"success" and api_error_status:null are not treated as errors', () => {
    const native = {
      subtype: "success",
      api_error_status: null,
      is_error: false,
      structured_output: { safe: true, reasons: "fine" },
    };
    expect(extractStructured({ kind: "triage", native }).kind).toBe("ok");
  });
});

describe("extractStructured — ajv candidate gate (ruling 3)", () => {
  it("REGRESSION: a findings candidate with one extra top-level key is rejected", () => {
    const native = {
      structured_output: {
        schema_version: "0.2.0",
        summary: "s",
        verdict: "comment",
        findings: [],
        unexpected: "field",
      },
    };
    const outcome = extractStructured({ kind: "findings", native });
    expect(outcome.kind).toBe("none");
  });

  it("fixture 7 (extra top-level key inside a fence) is rejected", () => {
    expect(extractFixture("findings", "f07-schema-violating.json").kind).toBe("none");
  });

  it("REGRESSION: a findings candidate with an extra key at a nested finding-item level is rejected", () => {
    const native = {
      structured_output: {
        schema_version: "0.2.0",
        summary: "s",
        verdict: "comment",
        findings: [
          {
            path: "a.ts",
            start_line: 1,
            end_line: 1,
            severity: "minor",
            title: "t",
            body: "b",
            unexpected: "field",
          },
        ],
      },
    };
    const outcome = extractStructured({ kind: "findings", native });
    expect(outcome.kind).toBe("none");
  });

  it("io-ts-only invariant (end_line >= start_line) rejects a candidate ajv alone would accept", () => {
    const native = {
      structured_output: {
        schema_version: "0.2.0",
        summary: "s",
        verdict: "comment",
        findings: [
          {
            path: "a.ts",
            start_line: 5,
            end_line: 1,
            severity: "minor",
            title: "t",
            body: "b",
          },
        ],
      },
    };
    const outcome = extractStructured({ kind: "findings", native });
    expect(outcome.kind).toBe("none");
  });

  it("an unsupported schema_version is rejected (counts as invalid, not surfaced separately)", () => {
    const native = {
      structured_output: {
        schema_version: "9.9.0",
        summary: "s",
        verdict: "comment",
        findings: [],
      },
    };
    expect(extractStructured({ kind: "findings", native }).kind).toBe("none");
  });
});

describe("extractStructured — ambiguity is fail (ruling 5, never first/last-wins)", () => {
  it("two differing validating fenced findings blocks are ambiguous, not the first or the last", () => {
    const outcome = extractFixture("findings", "f06-fenced-ambiguous.json");
    expect(outcome.kind).toBe("ambiguous");
  });

  it("the injection case (genuine safe:false + injected safe:true) is ambiguous", () => {
    const outcome = extractFixture("triage", "t19-injection-ambiguous.json");
    expect(outcome.kind).toBe("ambiguous");
  });
});

describe("extractStructured — exact duplicates collapse before the ambiguity check (dedup ruling)", () => {
  it("two byte-identical fenced findings blocks recover the single shared candidate, not ambiguous", () => {
    const outcome = extractFixture("findings", "f20-fenced-duplicate.json");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect((outcome.candidate as { summary: string }).summary).toBe(
      "Adds input validation to the upload handler.",
    );
  });

  it("two byte-identical fenced triage blocks recover the single shared candidate, not ambiguous", () => {
    const outcome = extractFixture("triage", "t21-fenced-duplicate.json");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect((outcome.candidate as { safe: boolean }).safe).toBe(false);
  });

  it("still treats two differing candidates as ambiguous — dedup does not weaken the injection defense", () => {
    expect(extractFixture("findings", "f06-fenced-ambiguous.json").kind).toBe("ambiguous");
    expect(extractFixture("triage", "t19-injection-ambiguous.json").kind).toBe("ambiguous");
  });
});

describe("extractStructured — CRLF fenced block (pins incidental behavior)", () => {
  it("recovers a valid candidate from a fenced block using CRLF line endings", () => {
    const findingsJson = JSON.stringify({
      schema_version: "0.2.0",
      summary: "CRLF fence.",
      verdict: "comment",
      findings: [],
    });
    const native = {
      result: `Here you go:\r\n\r\n\`\`\`json\r\n${findingsJson}\r\n\`\`\`\r\n`,
    };
    const outcome = extractStructured({ kind: "findings", native });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect((outcome.candidate as { summary: string }).summary).toBe("CRLF fence.");
  });
});

describe("withDefaultSchemaVersion", () => {
  it("injects the default version when schema_version is absent", () => {
    const result = withDefaultSchemaVersion({ summary: "s" }) as { schema_version: string };
    expect(result.schema_version).toBe("0.2.0");
  });

  it("leaves an explicit schema_version untouched", () => {
    const result = withDefaultSchemaVersion({ schema_version: "0.1.0" }) as {
      schema_version: string;
    };
    expect(result.schema_version).toBe("0.1.0");
  });

  it("passes through non-object candidates unchanged", () => {
    expect(withDefaultSchemaVersion("not an object")).toBe("not an object");
    expect(withDefaultSchemaVersion(null)).toBe(null);
    expect(withDefaultSchemaVersion([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("scanFencedBlocks — line-based fence scanner", () => {
  it("finds a ```json labeled block", () => {
    expect(scanFencedBlocks('lead-in\n```json\n{"a":1}\n```\ntrailing')).toEqual(['{"a":1}']);
  });

  it("finds a bare ``` block (no info string)", () => {
    expect(scanFencedBlocks('```\n{"a":1}\n```')).toEqual(['{"a":1}']);
  });

  it("discards text before, between, and after fences", () => {
    const text = 'before\n```\n{"a":1}\n```\nbetween\n```\n{"b":2}\n```\nafter';
    expect(scanFencedBlocks(text)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("discards an unterminated trailing fence", () => {
    expect(scanFencedBlocks('```json\n{"a":1}\nno closing fence here')).toEqual([]);
  });

  it("closes on a fence of >= the opening length, ignoring a shorter backtick run inside content", () => {
    const text = "````\ncontent with ``` (three backticks) inside\n````";
    expect(scanFencedBlocks(text)).toEqual(["content with ``` (three backticks) inside"]);
  });

  it("returns no blocks for plain prose", () => {
    expect(scanFencedBlocks("just some prose, no fences here")).toEqual([]);
  });
});

describe("ladderFailureDiagnostics", () => {
  it("flags a null structured_output and previews the result — the issue #3 failure shape", () => {
    // Real shape: --json-schema silently didn't enforce (structured_output null), so the model
    // guessed a key ("reason" vs "reasons") and the result fails the triage schema on every rung.
    const native = {
      structured_output: null,
      result: JSON.stringify({ safe: true, reason: "looks benign" }),
    };
    const diagnostics = ladderFailureDiagnostics({ kind: "triage", native });
    expect(diagnostics).toContain("structured_output rung: absent (null)");
    expect(diagnostics).toContain("result rung:");
    expect(diagnostics).toContain('"reason"');
  });

  it("notes the agent-file rung for findings and its absence when not provided", () => {
    const withFile = ladderFailureDiagnostics({
      kind: "findings",
      native: { result: "x" },
      agentFilePath: "/tmp/draft.json",
    });
    expect(withFile).toContain("agent-file rung: /tmp/draft.json");

    const withoutFile = ladderFailureDiagnostics({ kind: "findings", native: { result: "x" } });
    expect(withoutFile).toContain("agent-file rung: no --agent-file given");
  });
});

describe("describeLadderFailure", () => {
  it("renders a distinct message per non-ok outcome kind", () => {
    const messages = (["error-envelope", "none", "ambiguous"] as const).map((kind) =>
      describeLadderFailure({ kind, detail: "detail text" }),
    );
    expect(new Set(messages).size).toBe(3);
    for (const message of messages) expect(message).toContain("detail text");
  });
});
