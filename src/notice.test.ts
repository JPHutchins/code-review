import { describe, it, expect } from "vitest";
import {
  buildNoticeEnvelope,
  buildUnknownNoticeEnvelope,
  isNoticeKind,
  NOTICE_KINDS,
} from "./notice.js";
import { ResultEnvelopeCodec } from "./schema.js";

const KINDS = NOTICE_KINDS;

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

  it("renders an operational triage failure as an infra error, not a security verdict on the diff", () => {
    const summary = buildNoticeEnvelope(
      "triage-error",
      "Security triage did not complete successfully (operational error) — failing closed.",
    ).findings.summary;
    expect(summary).toContain("could not produce a verdict");
    expect(summary).toContain("not a finding about this diff");
    expect(summary).not.toContain("flagged as unsafe");
    expect(summary).toContain("> Security triage did not complete successfully");
  });

  it("keeps the triage-error wording even when no reason is supplied", () => {
    const summary = buildNoticeEnvelope("triage-error").findings.summary;
    expect(summary).toContain("could not produce a verdict");
    expect(summary).not.toContain("flagged as unsafe");
  });

  it("degrades an unrecognized kind to an honest incomplete envelope naming the version skew", () => {
    const env = buildUnknownNoticeEnvelope("some-future-kind");
    expect(env.incomplete).toBe(true);
    expect(env.findings.verdict).toBe("comment");
    expect(env.findings.summary).toContain("some-future-kind");
    expect(env.findings.summary).toContain("older than the workflow");
    expect(ResultEnvelopeCodec.decode(env)._tag).toBe("Right");
  });
});

describe("isNoticeKind", () => {
  it("accepts the known kinds and rejects anything else", () => {
    for (const k of KINDS) expect(isNoticeKind(k)).toBe(true);
    expect(isNoticeKind("clean")).toBe(false);
    expect(isNoticeKind("")).toBe(false);
  });
});
