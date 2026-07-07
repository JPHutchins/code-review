import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainstSchema, decodeFindings } from "./validate.js";
import type { Findings } from "./schema.js";
import { FindingsCodec, FindingCodec } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, "..", "schema", "findings.schema.json");

/** A finding conforming to the 0.4 shape — description, reasoning, confidence are all required. */
const finding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: "src/x.ts",
  start_line: 1,
  end_line: 1,
  severity: "minor",
  title: "A finding",
  description: "What is wrong.",
  reasoning: "Why it holds.",
  confidence: 0.7,
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

  it("validates findings with all optional fields (side, code, code_url, recommendation, patch)", () => {
    const full = doc([
      finding({
        side: "LEFT",
        code: "widened-type",
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
  it("encodes and decodes idempotently", () => {
    const data: Findings = {
      schema_version: "0.4.0",
      summary: "Test round-trip.",
      verdict: "changes",
      findings: [
        {
          path: "src/r.ts",
          start_line: 5,
          end_line: 10,
          side: "LEFT",
          severity: "critical",
          title: "Leak",
          description: "Memory leak detected.",
          reasoning: "The handle is opened but never closed on the error path.",
          confidence: 0.99,
          patch: "@@ -5 +5 @@\n-leak()\n+leak(); handle.close();",
        },
      ],
    };
    const encoded = FindingsCodec.encode(data);
    const decoded = decodeFindings(encoded);
    expect(decoded).toEqual(data);
  });
});

describe("FindingCodec — code / code_url (REQ-SC-7)", () => {
  it("accepts a finding with code and code_url", () => {
    const decoded = FindingCodec.decode(
      finding({ code: "null-check-missing", code_url: "https://example.com/rules/x" }),
    );
    expect(decoded._tag).toBe("Right");
  });

  it("accepts a finding with code but no code_url (both optional)", () => {
    const decoded = FindingCodec.decode(finding({ code: "rule-id-only" }));
    expect(decoded._tag).toBe("Right");
  });

  it("accepts a finding with neither code nor code_url", () => {
    const decoded = FindingCodec.decode(finding());
    expect(decoded._tag).toBe("Right");
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
