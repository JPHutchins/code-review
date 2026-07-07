import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideGate,
  draftState,
  readNudges,
  bumpNudges,
  shellQuote,
  defaultHookCommand,
  stopHookSettings,
} from "./stop-gate.js";
import type { DraftState } from "./stop-gate.js";
import { schemaPathFor } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const findingsSchema = resolve(__dirname, "..", "schema", "findings.schema.json");
const useFindingsSchema = (): string => findingsSchema;

const validDoc = { schema_version: "0.2.0", summary: "ok", verdict: "approve", findings: [] };

describe("decideGate", () => {
  const valid: DraftState = { present: true, valid: true, errors: [] };
  const missing: DraftState = { present: false, valid: false, errors: [] };
  const invalid: DraftState = {
    present: true,
    valid: false,
    errors: ["/verdict must be equal to one of the allowed values"],
  };

  it("allows when the draft is valid", () => {
    expect(decideGate(valid, 0, 5, "/d.json")).toEqual({ kind: "allow" });
  });

  it("allows once the nudge budget is spent, even if still invalid", () => {
    expect(decideGate(invalid, 5, 5, "/d.json").kind).toBe("allow");
  });

  it("blocks a missing draft with a reason that names it", () => {
    const d = decideGate(missing, 0, 5, "/d.json");
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.reason).toContain("does not exist");
      expect(d.reason).toContain("/d.json");
    }
  });

  it("blocks an invalid draft and surfaces the validator errors", () => {
    const d = decideGate(invalid, 1, 5, "/d.json");
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.reason).toContain("must be equal to one of");
  });
});

describe("draftState", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stop-gate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a missing file as not present", () => {
    expect(draftState(join(dir, "nope.json"), useFindingsSchema)).toEqual({
      present: false,
      valid: false,
      errors: [],
    });
  });

  it("reports invalid JSON as present but not valid", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    const s = draftState(p, useFindingsSchema);
    expect(s.present).toBe(true);
    expect(s.valid).toBe(false);
    expect(s.errors[0]).toContain("not valid JSON");
  });

  it("validates a well-formed findings document", () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify(validDoc));
    expect(draftState(p, useFindingsSchema).valid).toBe(true);
  });

  it("surfaces schema errors for a malformed findings document", () => {
    const p = join(dir, "malformed.json");
    writeFileSync(
      p,
      JSON.stringify({
        schema_version: "0.2.0",
        summary: "x",
        verdict: "approve",
        findings: "nope",
      }),
    );
    const s = draftState(p, useFindingsSchema);
    expect(s.valid).toBe(false);
    expect(s.errors.length).toBeGreaterThan(0);
  });

  it("treats an unsupported declared schema_version as invalid, not a crash", () => {
    const p = join(dir, "badver.json");
    writeFileSync(
      p,
      JSON.stringify({ schema_version: "0.1.0", summary: "x", verdict: "approve", findings: [] }),
    );
    const s = draftState(p, (parsed) =>
      schemaPathFor("findings", (parsed as { schema_version?: string }).schema_version),
    );
    expect(s.present).toBe(true);
    expect(s.valid).toBe(false);
    expect(s.errors.some((e) => e.includes("Unsupported"))).toBe(true);
  });
});

describe("nudge counter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stop-gate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads 0 when the counter is absent", () => {
    expect(readNudges(join(dir, "n"))).toBe(0);
  });

  it("bumps and reads back monotonically", () => {
    const p = join(dir, "n");
    bumpNudges(p, readNudges(p));
    expect(readNudges(p)).toBe(1);
    bumpNudges(p, readNudges(p));
    expect(readNudges(p)).toBe(2);
  });

  it("treats a garbage counter as 0", () => {
    const p = join(dir, "n");
    writeFileSync(p, "not-a-number");
    expect(readNudges(p)).toBe(0);
  });
});

describe("shellQuote", () => {
  it("wraps a plain path in single quotes", () => {
    expect(shellQuote("/tmp/x.json")).toBe("'/tmp/x.json'");
  });

  it("escapes an embedded single quote safely", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("defaultHookCommand", () => {
  it("embeds the quoted draft path and invokes stop-gate", () => {
    expect(defaultHookCommand("/t/d.json", {})).toBe("code-review stop-gate --draft '/t/d.json'");
  });

  it("propagates kind, schema-version, and max-nudges", () => {
    const c = defaultHookCommand("/t/d.json", {
      kind: "findings",
      schemaVersion: "0.3",
      maxNudges: "3",
    });
    expect(c).toContain("--kind 'findings'");
    expect(c).toContain("--schema-version '0.3'");
    expect(c).toContain("--max-nudges '3'");
  });
});

describe("stopHookSettings", () => {
  it("wires the command as a Stop hook", () => {
    const s = stopHookSettings("code-review stop-gate --draft '/x'");
    expect(s.hooks.Stop[0]?.hooks[0]).toEqual({
      type: "command",
      command: "code-review stop-gate --draft '/x'",
    });
  });
});
