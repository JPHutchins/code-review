import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFindings, decodeFindings } from "./validate.js";
import type { Findings } from "./schema.js";
import { FindingsCodec, FindingCodec } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, "..", "schema", "findings.schema.json");

const validFindings: unknown = {
  schema_version: "0.2.0",
  summary: "All looks good.",
  verdict: "approve",
  findings: [
    {
      path: "src/foo.ts",
      start_line: 42,
      end_line: 42,
      severity: "minor",
      title: "Use const",
      body: "This variable is never reassigned.",
      confidence: 0.85,
    },
  ],
};

describe("validateFindings", () => {
  it("validates a correct findings object", () => {
    const result = validateFindings(validFindings, schemaPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validates findings with zero findings array", () => {
    const result = validateFindings(
      { schema_version: "0.2.0", summary: "Clean.", verdict: "approve", findings: [] },
      schemaPath,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validates findings with all optional fields", () => {
    const full = {
      schema_version: "0.2.0",
      summary: "Full test.",
      verdict: "comment",
      findings: [
        {
          path: "src/a.ts",
          start_line: 10,
          end_line: 15,
          side: "LEFT" as const,
          severity: "major",
          code: "widened-type",
          code_url: "https://example.com/rules/widened-type",
          title: "Refactor",
          body: "Long body text.",
          suggestion: "// replacement",
          confidence: 0.5,
        },
        {
          path: "src/b.ts",
          start_line: 20,
          end_line: 20,
          side: "RIGHT" as const,
          severity: "nit",
          title: "Typo",
          body: "Fix typo.",
          suggestion: null,
        },
      ],
    };
    const result = validateFindings(full, schemaPath);
    expect(result.valid).toBe(true);
  });

  describe("required field validation", () => {
    it("rejects findings missing summary", () => {
      const result = validateFindings({ verdict: "approve", findings: [] }, schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("summary"))).toBe(true);
    });

    it("rejects findings missing verdict", () => {
      const result = validateFindings({ summary: "Test.", findings: [] }, schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("verdict"))).toBe(true);
    });

    it("rejects findings missing the findings array", () => {
      const result = validateFindings({ summary: "Test.", verdict: "approve" }, schemaPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("findings"))).toBe(true);
    });

    it("rejects a finding missing path", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              start_line: 1,
              end_line: 1,
              severity: "minor",
              title: "Missing path",
              body: "No path field.",
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("path"))).toBe(true);
    });

    it("rejects a finding missing severity", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 1,
              title: "Missing severity",
              body: "No severity field.",
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("severity"))).toBe(true);
    });

    it("rejects a finding missing title", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 1,
              severity: "minor",
              body: "No title field.",
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("title"))).toBe(true);
    });

    it("rejects a finding missing body", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 1,
              severity: "minor",
              title: "Missing body",
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("body"))).toBe(true);
    });
  });

  describe("out-of-range values", () => {
    it("rejects confidence below 0", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 1,
              severity: "minor",
              title: "Bad confidence",
              body: "Negative.",
              confidence: -0.1,
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("confidence"))).toBe(true);
    });

    it("rejects confidence above 1", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 1,
              severity: "minor",
              title: "Bad confidence",
              body: "Over one.",
              confidence: 1.5,
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("confidence"))).toBe(true);
    });

    it("accepts confidence at exactly 0", () => {
      const result = validateFindings(
        {
          schema_version: "0.2.0",
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 1,
              severity: "minor",
              title: "Edge confidence",
              body: "Zero.",
              confidence: 0,
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(true);
    });

    it("accepts confidence at exactly 1", () => {
      const result = validateFindings(
        {
          schema_version: "0.2.0",
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 1,
              severity: "minor",
              title: "Edge confidence",
              body: "One.",
              confidence: 1,
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(true);
    });

    it("rejects start_line of 0", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 0,
              end_line: 1,
              severity: "minor",
              title: "Zero start_line",
              body: "Zero.",
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("start_line"))).toBe(true);
    });

    it("rejects negative start_line", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: -1,
              end_line: 1,
              severity: "minor",
              title: "Negative start_line",
              body: "Negative.",
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("start_line"))).toBe(true);
    });

    it("rejects end_line of 0", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 0,
              severity: "minor",
              title: "Zero end_line",
              body: "Zero.",
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("end_line"))).toBe(true);
    });

    it("rejects invalid severity value", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 1,
              severity: "urgent",
              title: "Bad severity",
              body: "Not a valid severity.",
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("severity"))).toBe(true);
    });

    it("rejects invalid verdict value", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "reject",
          findings: [],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("verdict"))).toBe(true);
    });

    it("rejects invalid side value", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 1,
              side: "BOTH",
              severity: "minor",
              title: "Bad side",
              body: "Not a valid side.",
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("side"))).toBe(true);
    });
  });

  describe("additional properties", () => {
    it("rejects unknown top-level properties (strict schema)", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [],
          extraField: "should not be here",
        },
        schemaPath,
      );
      // Schema has additionalProperties: false
      expect(result.valid).toBe(false);
    });

    it("rejects unknown properties on findings items", () => {
      const result = validateFindings(
        {
          summary: "Test.",
          verdict: "approve",
          findings: [
            {
              path: "src/x.ts",
              start_line: 1,
              end_line: 1,
              severity: "minor",
              title: "Extra field",
              body: "Has extra.",
              extraProp: true,
            },
          ],
        },
        schemaPath,
      );
      expect(result.valid).toBe(false);
    });
  });
});

describe("decodeFindings", () => {
  it("decodes valid findings JSON successfully", () => {
    const decoded = decodeFindings(validFindings);
    expect(decoded.summary).toBe("All looks good.");
    expect(decoded.verdict).toBe("approve");
    expect(decoded.findings).toHaveLength(1);
    expect(decoded.findings[0]!.title).toBe("Use const");
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

  it("round-trips through Codec and validateFindings", () => {
    const decoded = decodeFindings(validFindings);
    // Re-validate the decoded object
    const result = validateFindings(decoded, schemaPath);
    expect(result.valid).toBe(true);
  });
});

describe("FindingsCodec (io-ts round-trip)", () => {
  it("encodes and decodes idempotently", () => {
    const data: Findings = {
      schema_version: "0.2.0",
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
          body: "Memory leak detected.",
          suggestion: null,
          confidence: 0.99,
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
    const finding = {
      path: "src/a.ts",
      start_line: 1,
      end_line: 1,
      severity: "minor",
      code: "null-check-missing",
      code_url: "https://example.com/rules/null-check-missing",
      title: "Missing null check",
      body: "Add a null check.",
    };
    const decoded = FindingCodec.decode(finding);
    expect(decoded._tag).toBe("Right");
  });

  it("accepts a finding with code but no code_url (both optional)", () => {
    const finding = {
      path: "src/a.ts",
      start_line: 1,
      end_line: 1,
      severity: "minor",
      code: "rule-id-only",
      title: "Has code only",
      body: "Body.",
    };
    const decoded = FindingCodec.decode(finding);
    expect(decoded._tag).toBe("Right");
  });

  it("accepts a finding with neither code nor code_url", () => {
    const finding = {
      path: "src/a.ts",
      start_line: 1,
      end_line: 1,
      severity: "minor",
      title: "No code fields",
      body: "Body.",
    };
    const decoded = FindingCodec.decode(finding);
    expect(decoded._tag).toBe("Right");
  });
});

describe("FindingCodec — end_line >= start_line (REQ-SC-6)", () => {
  it("accepts end_line == start_line", () => {
    const decoded = FindingCodec.decode({
      path: "src/a.ts",
      start_line: 5,
      end_line: 5,
      severity: "minor",
      title: "Same line",
      body: "Body.",
    });
    expect(decoded._tag).toBe("Right");
  });

  it("accepts end_line > start_line", () => {
    const decoded = FindingCodec.decode({
      path: "src/a.ts",
      start_line: 5,
      end_line: 10,
      severity: "minor",
      title: "Range",
      body: "Body.",
    });
    expect(decoded._tag).toBe("Right");
  });

  it("rejects end_line < start_line", () => {
    const decoded = FindingCodec.decode({
      path: "src/a.ts",
      start_line: 10,
      end_line: 5,
      severity: "minor",
      title: "Inverted range",
      body: "Body.",
    });
    expect(decoded._tag).toBe("Left");
  });
});
