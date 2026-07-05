import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve, schemaPathFor, defaultVersion, supportedVersions } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, "..");

const validFindings = {
  schema_version: "0.2.0",
  summary: "A summary.",
  verdict: "comment",
  findings: [],
};

describe('resolve("findings", ...)', () => {
  it("resolves a supported version to ok with the decoded, normalized value", () => {
    const result = resolve("findings", validFindings);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.version).toBe("0.2.0");
    expect(result.value.summary).toBe("A summary.");
  });

  it("ignores the patch component when dispatching", () => {
    const result = resolve("findings", { ...validFindings, schema_version: "0.2.99" });
    expect(result.kind).toBe("ok");
  });

  it("returns unsupported-version for an out-of-allowlist major.minor, listing what's supported", () => {
    const result = resolve("findings", { ...validFindings, schema_version: "1.0.0" });
    expect(result.kind).toBe("unsupported-version");
    if (result.kind !== "unsupported-version") return;
    expect(result.version).toBe("1.0.0");
    expect(result.supported).toEqual(["0.2"]);
  });

  it("returns invalid-shape for a supported version with a malformed body", () => {
    const result = resolve("findings", { schema_version: "0.2.0", summary: "s" });
    expect(result.kind).toBe("invalid-shape");
    if (result.kind !== "invalid-shape") return;
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns missing-version when schema_version is absent", () => {
    const withoutVersion: Record<string, unknown> = { ...validFindings };
    delete withoutVersion["schema_version"];
    const result = resolve("findings", withoutVersion);
    expect(result.kind).toBe("missing-version");
  });

  it("returns missing-version for a non-object document", () => {
    expect(resolve("findings", null).kind).toBe("missing-version");
    expect(resolve("findings", "not an object").kind).toBe("missing-version");
  });

  it("does not confuse '0.20.x' with the supported '0.2' minor (majorMinor dispatch precision)", () => {
    const r1 = resolve("findings", { ...validFindings, schema_version: "0.20.0" });
    expect(r1.kind).toBe("unsupported-version");
    if (r1.kind === "unsupported-version") expect(r1.version).toBe("0.20.0");

    const r2 = resolve("findings", { ...validFindings, schema_version: "0.20" });
    expect(r2.kind).toBe("unsupported-version");
  });

  it("F3: rejects a schema_version missing the patch component, even though its major.minor is supported", () => {
    const result = resolve("findings", { ...validFindings, schema_version: "0.2" });
    expect(result.kind).toBe("invalid-shape");
  });

  it("F3: rejects a schema_version with a superfluous extra component", () => {
    const result = resolve("findings", { ...validFindings, schema_version: "0.2.0.0" });
    expect(result.kind).toBe("invalid-shape");
  });

  it("F3: still accepts a full patch version (regression guard against over-tightening)", () => {
    expect(resolve("findings", { ...validFindings, schema_version: "0.2.0" }).kind).toBe("ok");
    expect(resolve("findings", { ...validFindings, schema_version: "0.2.7" }).kind).toBe("ok");
  });
});

describe('resolve("triage" | "prices", ...) — no in-data version signal', () => {
  it("resolves a valid triage object to ok, reporting the entry's defaultVersion", () => {
    const result = resolve("triage", { safe: true, reasons: "Looks fine." });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.version).toBe(defaultVersion("triage"));
    expect(result.value.safe).toBe(true);
  });

  it("returns invalid-shape for a malformed triage object", () => {
    const result = resolve("triage", { safe: "not a boolean" });
    expect(result.kind).toBe("invalid-shape");
  });

  it("resolves a valid price map to ok, reporting the entry's defaultVersion", () => {
    const result = resolve("prices", {
      _updated: "2026-07-03",
      _unit: "USD per 1M tokens",
      models: {},
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.version).toBe(defaultVersion("prices"));
  });

  it("returns invalid-shape for a malformed price map", () => {
    const result = resolve("prices", { models: {} });
    expect(result.kind).toBe("invalid-shape");
  });
});

describe("schemaPathFor", () => {
  it("with no version returns the flat latest file", () => {
    const path = schemaPathFor("findings");
    expect(path).toBe(resolvePath(repoRoot, "schema", "findings.schema.json"));
  });

  it("is byte-identical to the source schema file print-schema reads (load-bearing invariant)", () => {
    const path = schemaPathFor("findings");
    expect(readFileSync(path, "utf-8")).toBe(
      readFileSync(resolvePath(repoRoot, "schema", "findings.schema.json"), "utf-8"),
    );
  });

  it("resolves a supported major.minor (with or without patch) to the same flat file", () => {
    expect(schemaPathFor("findings", "0.2")).toBe(schemaPathFor("findings"));
    expect(schemaPathFor("findings", "0.2.7")).toBe(schemaPathFor("findings"));
  });

  it("throws a clear error listing supported versions for an unsupported version", () => {
    expect(() => schemaPathFor("findings", "9.9")).toThrow(
      /Unsupported findings schema version "9.9" — supported: 0.2/,
    );
  });

  it("resolves triage and prices to their bundled files", () => {
    expect(schemaPathFor("triage")).toBe(resolvePath(repoRoot, "schema", "triage.schema.json"));
    expect(schemaPathFor("prices")).toBe(resolvePath(repoRoot, "schema", "prices.schema.json"));
  });
});

describe("defaultVersion / supportedVersions", () => {
  it("report today's single supported entry per kind", () => {
    expect(defaultVersion("findings")).toBe("0.2.0");
    expect(supportedVersions("findings")).toEqual(["0.2"]);
    expect(defaultVersion("triage")).toBe("0.1.0");
    expect(supportedVersions("triage")).toEqual(["0.1"]);
    expect(defaultVersion("prices")).toBe("0.1.0");
    expect(supportedVersions("prices")).toEqual(["0.1"]);
  });
});
