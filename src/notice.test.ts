import { describe, it, expect } from "vitest";
import { buildNoticeEnvelope, isNoticeKind } from "./notice.js";
import type { NoticeKind } from "./notice.js";
import { ResultEnvelopeCodec } from "./schema.js";

const KINDS: readonly NoticeKind[] = [
  "security-blocked",
  "setup-failed",
  "checkout-failed",
  "no-output",
];

describe("buildNoticeEnvelope", () => {
  it("flags every kind incomplete, with zeroed telemetry that round-trips the envelope codec", () => {
    for (const kind of KINDS) {
      const env = buildNoticeEnvelope(kind);
      expect(env.incomplete).toBe(true);
      expect(env.models).toEqual([]);
      expect(env.turns).toBe(0);
      expect(env.duration_ms).toBe(0);
      expect(env.vendor_cost_usd).toBeNull();
      expect(env.findings.findings).toEqual([]);
      expect(env.findings.verdict).toBe("comment");
      expect(ResultEnvelopeCodec.decode(env)._tag).toBe("Right");
    }
  });

  it("embeds the triage reason for a security block when one is given", () => {
    const env = buildNoticeEnvelope("security-blocked", "curl | bash spotted in the diff");
    expect(env.findings.summary).toContain("security gate");
    expect(env.findings.summary).toContain("curl | bash spotted in the diff");
  });

  it("blockquotes every line of a multi-line reason, not just the first", () => {
    const env = buildNoticeEnvelope("security-blocked", "line one\nline two");
    expect(env.findings.summary).toContain("> line one\n> line two");
  });

  it("uses the no-reason wording when the security-block reason is empty or absent", () => {
    expect(buildNoticeEnvelope("security-blocked").findings.summary).toContain("without a reason");
    expect(buildNoticeEnvelope("security-blocked", "   ").findings.summary).toContain(
      "without a reason",
    );
  });

  it("keeps setup-failed, no-output, and checkout-failed as distinct messages", () => {
    expect(buildNoticeEnvelope("setup-failed").findings.summary).toContain("did not run");
    expect(buildNoticeEnvelope("no-output").findings.summary).toContain("did not complete");
    expect(buildNoticeEnvelope("checkout-failed").findings.summary).toContain(
      "Could not check out the PR head",
    );
  });
});

describe("isNoticeKind", () => {
  it("accepts the four kinds and rejects anything else", () => {
    for (const k of KINDS) expect(isNoticeKind(k)).toBe(true);
    expect(isNoticeKind("clean")).toBe(false);
    expect(isNoticeKind("")).toBe(false);
  });
});
