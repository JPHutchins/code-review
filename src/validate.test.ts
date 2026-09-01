import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateAgainstSchema, decodeFindings } from "./validate.js";
import type { Findings } from "./schema.js";
import { FindingsCodec, FindingCodec } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, "..", "schema", "findings.schema.json");

/** A finding conforming to the current shape — id, description, reasoning, confidence all required. */
const finding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: "src/x.ts",
  start_line: 1,
  end_line: 1,
  severity: "minor",
  id: "test-finding",
  title: "A finding",
  description: "What is wrong.",
  reasoning: "Why it holds.",
  confidence: 0.7,
  likelihood: 1,
  ...overrides,
});

/** A finding with the named key removed (for the required-field rejection tests). */
const findingWithout = (key: string): Record<string, unknown> => {
  const f = finding();
  Reflect.deleteProperty(f, key);
  return f;
};

const doc = (findings: readonly unknown[], overrides: Record<string, unknown> = {}): unknown => ({
  schema_version: "0.4.0",
  summary: "A summary.",
  verdict: "approve",
  findings,
  ...overrides,
});

const validFindings = doc([finding({ title: "Use const", description: "Never reassigned." })]);

describe("validateAgainstSchema", () => {
  it("validates a correct findings object", () => {
    const result = validateAgainstSchema(validFindings, schemaPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validates findings with zero findings array", () => {
    const result = validateAgainstSchema(doc([]), schemaPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validates findings with all optional fields (side, code_url, recommendation, patch)", () => {
    const full = doc([
      finding({
        side: "LEFT",
        id: "widened-type",
        code_url: "https://example.com/rules/widened-type",
        title: "Refactor",
        recommendation: "Add a `parseTimeout` helper at the edge.",
        patch: ["@@ -10 +10 @@", "-old", "+new"].join("\n"),
        confidence: 0.5,
      }),
      finding({ path: "src/b.ts", start_line: 20, end_line: 20, side: "RIGHT" }),
    ]);
    const result = validateAgainstSchema(full, schemaPath);
    expect(result.valid).toBe(true);
  });

  describe("change_size (issue #182)", () => {
    const withChangeSize = (cs: unknown): unknown => doc([], { change_size: cs });
    it("validates a well-formed change_size (and a single-role partial)", () => {
      expect(
        validateAgainstSchema(
          withChangeSize({ code: { added: 240, removed: 80 }, tests: { added: 12, removed: 0 } }),
          schemaPath,
        ).valid,
      ).toBe(true);
      expect(
        validateAgainstSchema(withChangeSize({ docs: { added: 3, removed: 0 } }), schemaPath).valid,
      ).toBe(true);
    });

    it("rejects a negative or non-integer line count", () => {
      expect(
        validateAgainstSchema(withChangeSize({ code: { added: -1, removed: 0 } }), schemaPath)
          .valid,
      ).toBe(false);
      expect(
        validateAgainstSchema(withChangeSize({ code: { added: 1.5, removed: 0 } }), schemaPath)
          .valid,
      ).toBe(false);
    });

    it("rejects a role missing added/removed, and an unknown role key", () => {
      expect(validateAgainstSchema(withChangeSize({ code: { added: 1 } }), schemaPath).valid).toBe(
        false,
      );
      expect(
        validateAgainstSchema(withChangeSize({ generated: { added: 1, removed: 0 } }), schemaPath)
          .valid,
      ).toBe(false);
    });
  });

  describe("required field validation", () => {
    it("rejects findings missing summary", () => {
      const result = validateAgainstSchema({ verdict: "approve", findings: [] }, schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("summary"))).toBe(true);
    });

    it("rejects findings missing verdict", () => {
      const result = validateAgainstSchema({ summary: "Test.", findings: [] }, schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("verdict"))).toBe(true);
    });

    it("rejects findings missing the findings array", () => {
      const result = validateAgainstSchema({ summary: "Test.", verdict: "approve" }, schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("findings"))).toBe(true);
    });

    it("rejects a finding missing path", () => {
      const result = validateAgainstSchema(doc([findingWithout("path")]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("path"))).toBe(true);
    });

    it("rejects a finding missing severity", () => {
      const result = validateAgainstSchema(doc([findingWithout("severity")]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("severity"))).toBe(true);
    });

    it("rejects a finding missing title", () => {
      const result = validateAgainstSchema(doc([findingWithout("title")]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("title"))).toBe(true);
    });

    it("rejects a finding missing description (0.4 renamed body → description)", () => {
      const result = validateAgainstSchema(doc([findingWithout("description")]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("description"))).toBe(true);
    });

    it("rejects a finding missing reasoning (now required)", () => {
      const result = validateAgainstSchema(doc([findingWithout("reasoning")]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("reasoning"))).toBe(true);
    });

    it("rejects a finding missing confidence (now required)", () => {
      const result = validateAgainstSchema(doc([findingWithout("confidence")]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("confidence"))).toBe(true);
    });

    it("rejects a finding missing likelihood (issue #163 — required)", () => {
      const result = validateAgainstSchema(doc([findingWithout("likelihood")]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("likelihood"))).toBe(true);
    });

    it("rejects a finding missing id (0.10 renamed code → id and made it required)", () => {
      const result = validateAgainstSchema(doc([findingWithout("id")]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("id"))).toBe(true);
      expect(FindingCodec.decode(findingWithout("id"))._tag).toBe("Left");
    });
  });

  describe("out-of-range values", () => {
    it("rejects confidence below 0", () => {
      const result = validateAgainstSchema(doc([finding({ confidence: -0.1 })]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("confidence"))).toBe(true);
    });

    it("rejects confidence above 1", () => {
      const result = validateAgainstSchema(doc([finding({ confidence: 1.5 })]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("confidence"))).toBe(true);
    });

    it("accepts confidence at exactly 0", () => {
      expect(validateAgainstSchema(doc([finding({ confidence: 0 })]), schemaPath).valid).toBe(true);
    });

    it("accepts confidence at exactly 1", () => {
      expect(validateAgainstSchema(doc([finding({ confidence: 1 })]), schemaPath).valid).toBe(true);
    });

    it("rejects start_line of 0", () => {
      const result = validateAgainstSchema(doc([finding({ start_line: 0 })]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("start_line"))).toBe(true);
    });

    it("rejects negative start_line", () => {
      const result = validateAgainstSchema(doc([finding({ start_line: -1 })]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("start_line"))).toBe(true);
    });

    it("rejects end_line of 0", () => {
      const result = validateAgainstSchema(doc([finding({ end_line: 0 })]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("end_line"))).toBe(true);
    });

    it("rejects invalid severity value", () => {
      const result = validateAgainstSchema(doc([finding({ severity: "urgent" })]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("severity"))).toBe(true);
    });

    it("rejects invalid verdict value", () => {
      const result = validateAgainstSchema(doc([], { verdict: "reject" }), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("verdict"))).toBe(true);
    });

    it("accepts the pipeline-reserved `error` verdict (0.5 widened the enum)", () => {
      const result = validateAgainstSchema(doc([], { verdict: "error" }), schemaPath);
      expect(result.valid).toBe(true);
    });

    it("rejects invalid side value", () => {
      const result = validateAgainstSchema(doc([finding({ side: "BOTH" })]), schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("side"))).toBe(true);
    });
  });

  describe("additional properties", () => {
    it("rejects unknown top-level properties (strict schema)", () => {
      const result = validateAgainstSchema(
        doc([], { extraField: "should not be here" }),
        schemaPath,
      );
      expect(result.valid).toBe(false);
    });

    it("rejects unknown properties on findings items", () => {
      const result = validateAgainstSchema(doc([finding({ extraProp: true })]), schemaPath);
      expect(result.valid).toBe(false);
    });

    it("rejects the removed `suggestion` field (0.4 dropped it in favor of `patch`)", () => {
      const result = validateAgainstSchema(doc([finding({ suggestion: "// x" })]), schemaPath);
      expect(result.valid).toBe(false);
    });

    it("rejects the removed `body` field (0.4 renamed it to `description`)", () => {
      const result = validateAgainstSchema(doc([finding({ body: "old field" })]), schemaPath);
      expect(result.valid).toBe(false);
    });

    it("rejects the removed `code` field (0.10 renamed it to `id`)", () => {
      const result = validateAgainstSchema(doc([finding({ code: "old-field" })]), schemaPath);
      expect(result.valid).toBe(false);
      // The codec gate now rejects it too (the strict-key refinement) — a 0.10-stamped finding
      // carrying BOTH spellings must not pass one gate and fail the other.
      expect(FindingCodec.decode(finding({ id: "keep-me", code: "old-field" }))._tag).toBe("Left");
    });
  });
});

describe("decodeFindings", () => {
  it("decodes valid findings JSON successfully", () => {
    const decoded = decodeFindings(validFindings);
    expect(decoded.summary).toBe("A summary.");
    expect(decoded.verdict).toBe("approve");
    expect(decoded.findings).toHaveLength(1);
    expect(decoded.findings[0]!.title).toBe("Use const");
    expect(decoded.findings[0]!.description).toBe("Never reassigned.");
  });

  it("throws on invalid data", () => {
    expect(() => decodeFindings({})).toThrow();
  });

  it("throws on null input", () => {
    expect(() => decodeFindings(null)).toThrow();
  });

  it("throws on undefined input", () => {
    expect(() => decodeFindings(undefined)).toThrow();
  });

  it("round-trips through Codec and validateAgainstSchema", () => {
    const decoded = decodeFindings(validFindings);
    const result = validateAgainstSchema(decoded, schemaPath);
    expect(result.valid).toBe(true);
  });
});

describe("FindingsCodec (io-ts round-trip)", () => {
  it("the preview fixture stays on the current shape — scripts/preview.ts decodes it through this codec", () => {
    const preview = JSON.parse(
      readFileSync(resolve(__dirname, "..", "test", "fixtures", "preview.findings.json"), "utf-8"),
    ) as unknown;
    expect(FindingsCodec.decode(preview)._tag).toBe("Right");
  });

  it("encodes and decodes idempotently", () => {
    const data: Findings = {
      schema_version: "0.4.0",
      summary: "Test round-trip.",
      verdict: "changes",
      findings: [
        {
          id: "test-id",
          path: "src/r.ts",
          start_line: 5,
          end_line: 10,
          side: "LEFT",
          severity: "critical",
          title: "Leak",
          description: "Memory leak detected.",
          reasoning: "The handle is opened but never closed on the error path.",
          confidence: 0.99,
          likelihood: 1,
          patch: "@@ -5 +5 @@\n-leak()\n+leak(); handle.close();",
        },
      ],
    };
    const encoded = FindingsCodec.encode(data);
    const decoded = decodeFindings(encoded);
    expect(decoded).toEqual(data);
  });
});

describe("FindingCodec — id / code_url (REQ-SC-7)", () => {
  it("accepts a finding with id and code_url", () => {
    const decoded = FindingCodec.decode(
      finding({ id: "null-check-missing", code_url: "https://example.com/rules/x" }),
    );
    expect(decoded._tag).toBe("Right");
  });

  it("accepts a finding with id but no code_url (code_url is optional)", () => {
    const decoded = FindingCodec.decode(finding({ id: "rule-id-only" }));
    expect(decoded._tag).toBe("Right");
  });

  it("accepts a finding with no code_url", () => {
    const decoded = FindingCodec.decode(finding());
    expect(decoded._tag).toBe("Right");
  });

  it("rejects a non-URI code_url — mirroring the schema's format: uri so the codec gate agrees with the ajv gate (issue #134 review)", () => {
    expect(FindingCodec.decode(finding({ code_url: "/docs/rules/foo" }))._tag).toBe("Left");
    expect(FindingCodec.decode(finding({ code_url: "not a url" }))._tag).toBe("Left");
  });
});

describe("FindingCodec — end_line >= start_line (REQ-SC-6)", () => {
  it("accepts end_line == start_line", () => {
    expect(FindingCodec.decode(finding({ start_line: 5, end_line: 5 }))._tag).toBe("Right");
  });

  it("accepts end_line > start_line", () => {
    expect(FindingCodec.decode(finding({ start_line: 5, end_line: 10 }))._tag).toBe("Right");
  });

  it("rejects end_line < start_line", () => {
    expect(FindingCodec.decode(finding({ start_line: 10, end_line: 5 }))._tag).toBe("Left");
  });
});

describe("FindingCodec — patch is a plain string, never null (0.4)", () => {
  it("accepts a string patch", () => {
    expect(FindingCodec.decode(finding({ patch: "@@ -1 +1 @@\n-a\n+b" }))._tag).toBe("Right");
  });

  it("rejects a null patch (0.4 dropped the null variant — omit the field instead)", () => {
    expect(FindingCodec.decode(finding({ patch: null }))._tag).toBe("Left");
  });

  it("accepts an absent patch", () => {
    expect(FindingCodec.decode(finding())._tag).toBe("Right");
  });
});

describe("systemic_problems (issue #134 — cross-cutting observations without line anchors)", () => {
  const systemic = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    title: "Inconsistent retry policy",
    description: "Three spots, three retry policies.",
    severity: "major",
    reasoning: "Each file implements its own policy.",
    confidence: 0.8,
    likelihood: 1,
    ...overrides,
  });

  const withSystemic = (items: readonly unknown[]): unknown =>
    doc([], { systemic_problems: items });

  it("accepts a valid systemic problem with all required fields", () => {
    expect(validateAgainstSchema(withSystemic([systemic()]), schemaPath).valid).toBe(true);
  });

  it("accepts every optional field (code, code_url, finding_ids, paths)", () => {
    const result = validateAgainstSchema(
      withSystemic([
        systemic({
          id: "retry-policy-inconsistent",
          code_url: "https://example.com/rules/retry-policy-inconsistent",
          finding_ids: ["widened-type", "null-check-missing"],
          paths: ["src/a.ts", "src/b.ts"],
        }),
      ]),
      schemaPath,
    );
    expect(result.valid).toBe(true);
  });

  it("treats the field as optional — a document without it still validates (0.5 backward compat)", () => {
    expect(validateAgainstSchema(validFindings, schemaPath).valid).toBe(true);
  });

  it("rejects a systemic item missing title", () => {
    const withoutTitle: Record<string, unknown> = systemic();
    Reflect.deleteProperty(withoutTitle, "title");
    const result = validateAgainstSchema(withSystemic([withoutTitle]), schemaPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("title"))).toBe(true);
  });

  it("rejects a systemic item missing description", () => {
    const withoutDescription: Record<string, unknown> = systemic();
    Reflect.deleteProperty(withoutDescription, "description");
    const result = validateAgainstSchema(withSystemic([withoutDescription]), schemaPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("description"))).toBe(true);
  });

  it("rejects a systemic item missing severity (required per owner direction)", () => {
    const withoutSeverity: Record<string, unknown> = systemic();
    Reflect.deleteProperty(withoutSeverity, "severity");
    const result = validateAgainstSchema(withSystemic([withoutSeverity]), schemaPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("severity"))).toBe(true);
  });

  it("rejects a systemic item missing reasoning (required per owner direction)", () => {
    const withoutReasoning: Record<string, unknown> = systemic();
    Reflect.deleteProperty(withoutReasoning, "reasoning");
    const result = validateAgainstSchema(withSystemic([withoutReasoning]), schemaPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("reasoning"))).toBe(true);
  });

  it("rejects a systemic item missing confidence (required per owner direction)", () => {
    const withoutConfidence: Record<string, unknown> = systemic();
    Reflect.deleteProperty(withoutConfidence, "confidence");
    const result = validateAgainstSchema(withSystemic([withoutConfidence]), schemaPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("confidence"))).toBe(true);
  });

  it("rejects an unknown property on a systemic item (strict schema)", () => {
    const result = validateAgainstSchema(withSystemic([systemic({ line_range: 12 })]), schemaPath);
    expect(result.valid).toBe(false);
  });

  it("rejects an out-of-enum severity on a systemic item", () => {
    const result = validateAgainstSchema(
      withSystemic([systemic({ severity: "urgent" })]),
      schemaPath,
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a non-string finding_ids entry", () => {
    const result = validateAgainstSchema(
      withSystemic([systemic({ finding_ids: ["ok", 7] })]),
      schemaPath,
    );
    expect(result.valid).toBe(false);
  });

  it("codec rejects unknown keys on a systemic item on decode — matching the schema's additionalProperties:false (issue #134 review)", () => {
    expect(FindingsCodec.decode(withSystemic([systemic({ bogus: 1 })]))._tag).toBe("Left");
  });

  it("codec accepts an absolute-URI code_url on a systemic item", () => {
    const result = FindingsCodec.decode(
      withSystemic([systemic({ code_url: "https://example.com/rules/retry" })]),
    );
    expect(result._tag).toBe("Right");
  });

  it("codec rejects a non-URI code_url on a systemic item — mirroring the schema's format: uri (issue #134 review)", () => {
    const result = FindingsCodec.decode(withSystemic([systemic({ code_url: "/docs/rules/foo" })]));
    expect(result._tag).toBe("Left");
  });

  it("codec rejects a systemic item missing a required field on decode", () => {
    const withoutConfidence: Record<string, unknown> = systemic();
    Reflect.deleteProperty(withoutConfidence, "confidence");
    expect(FindingsCodec.decode(withSystemic([withoutConfidence]))._tag).toBe("Left");
  });

  it("round-trips systemic_problems through the io-ts codec", () => {
    const data: Findings = {
      ...decodeFindings(validFindings),
      systemic_problems: [
        {
          title: "Retry inconsistency",
          description: "Three policies in three spots.",
          severity: "major",
          reasoning: "Each file implements its own policy.",
          confidence: 0.8,
          likelihood: 1,
          finding_ids: ["widened-type"],
        },
      ],
    };
    const decoded = decodeFindings(FindingsCodec.encode(data));
    expect(decoded.systemic_problems).toEqual(data.systemic_problems);
  });
});
