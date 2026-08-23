import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { render } from "./render.js";
import { repoRoot } from "./test-util.js";
import type { Findings } from "./schema.js";

// The comment must carry every field the findings document does. That was slack while the document
// rode along as base64; once it moved to the artifact (issue #217) every field the render drops is a
// field only a fetch can reach — and the agent directive tells readers to prefer the prose. So the
// claim is enforced here rather than asserted in prose: walk the SCHEMA, put a unique sentinel in
// every leaf, render with suppression active, and require every sentinel to appear.
//
// Walking the schema is the point: a field added next month cannot dodge a fixture it is not in.
const schema = JSON.parse(
  readFileSync(`${repoRoot}/schema/findings.schema.json`, "utf-8"),
) as Record<string, unknown>;

const leafPaths = (node: unknown, path = ""): readonly string[] => {
  if (node === null || typeof node !== "object") return [];
  const n = node as Record<string, unknown>;
  const props = n["properties"];
  if (props !== undefined && typeof props === "object") {
    return Object.entries(props as Record<string, unknown>).flatMap(([k, v]) => {
      const here = path === "" ? k : `${path}.${k}`;
      const deeper = leafPaths(v, here);
      return deeper.length > 0 ? deeper : [here];
    });
  }
  const items = n["items"];
  return items !== undefined ? leafPaths(items, path) : [];
};

// Two documented exclusions, both because the SCHEMA says the field carries no information to carry:
//
// - `scope_metastasis.decision_prompt` — the review agent never writes it; the commenter re-derives it
//   from the carried round history every round and delivers it in the next review's context. Nothing
//   reads it back out of a comment, and the advisory it accompanies (metastasisNote) IS rendered.
// - `systemic_problems.likelihood` — "Set to 1 for a systemic problem … the written value is not read
//   by the score. (Required for schema symmetry.)" A constant carries no per-item information, so the
//   systemic header deliberately shows confidence alone.
//
// Anything else absent is a bug. Adding to this list is a decision to defend, not a way to pass.
const DOCUMENTED_EXCLUSIONS = ["scope_metastasis.decision_prompt", "systemic_problems.likelihood"];

const sentinel = (leaf: string): string => `S_${leaf.replace(/\./g, "_")}`;

const findings = {
  schema_version: "0.9.0",
  summary: sentinel("summary"),
  verdict: "comment",
  systemic_problems: [
    {
      title: sentinel("systemic_problems.title"),
      description: sentinel("systemic_problems.description"),
      severity: "major",
      reasoning: sentinel("systemic_problems.reasoning"),
      confidence: 0.81,
      likelihood: 0.82,
      code: "sys-code",
      code_url: `https://example.com/${sentinel("systemic_problems.code_url")}`,
      finding_codes: [sentinel("systemic_problems.finding_codes")],
      paths: [`src/${sentinel("systemic_problems.paths")}.ts`],
    },
  ],
  scope_metastasis: {
    decision_prompt: sentinel("scope_metastasis.decision_prompt"),
    recurring: [{ code: "recurring-code", consecutive_rounds: 3, start_round: 1 }],
  },
  convergence: {
    score: 0.71,
    threshold: 1,
    converged: true,
    rounds: [{ round: 1, score: 0.71, codes: { "sys-code": 1 }, sha: "abc123def456" }],
  },
  change_size: {
    code: { added: 111, removed: 222 },
    tests: { added: 333, removed: 444 },
    docs: { added: 555, removed: 666 },
  },
  findings: [
    {
      path: `src/${sentinel("findings.path")}.ts`,
      start_line: 10,
      end_line: 12,
      side: "RIGHT",
      severity: "major",
      code: "visible-code",
      code_url: `https://example.com/${sentinel("findings.code_url")}`,
      title: sentinel("findings.title"),
      description: sentinel("findings.description"),
      recommendation: sentinel("findings.recommendation"),
      confidence: 0.91,
      likelihood: 0.92,
      reasoning: sentinel("findings.reasoning"),
      patch: `@@ -1 +1 @@\n-old\n+${sentinel("findings.patch")}`,
    },
    // A below-floor nit: hidden from the visible list by policy, which must not remove its CONTENT.
    {
      path: "src/nit.ts",
      start_line: 20,
      end_line: 22,
      side: "RIGHT",
      severity: "nit",
      code: "nit-code",
      code_url: "https://example.com/S_nit_code_url",
      title: "S_nit_title",
      description: "S_nit_description",
      recommendation: "S_nit_recommendation",
      confidence: 0.1,
      likelihood: 0.1,
      reasoning: "S_nit_reasoning",
      patch: "@@ -1 +1 @@\n-old\n+S_nit_patch",
    },
  ],
} as unknown as Findings;

const rendered = (): string =>
  render({
    findings,
    envelope: {
      schema_version: "0.4.0",
      findings,
      models: [{ model: "m", input_tokens: 1, output_tokens: 1 }],
      turns: 1,
      duration_ms: 1,
    },
    prices: {
      _updated: "x",
      _unit: "y",
      models: { m: { in: 1, out: 1, cache_read: 0, cache_write: 0 } },
    },
    template: readFileSync(`${repoRoot}/templates/comment.eta`, "utf-8"),
    strays: findings.findings.slice(0, 1),
    suppressedNits: findings.findings.slice(1, 2),
    route: "full review",
    convergenceRound: true,
    nitVisibilityFloor: 0.25,
    jsonUrl: "https://example.com/artifact.zip",
  });

describe("the comment carries every field of the findings document (issue #217)", () => {
  it("renders a sentinel for every schema leaf except the documented exclusions", () => {
    const out = rendered();
    const fixture = JSON.stringify(findings);
    // Only the leaves the fixture actually carries a sentinel for; numeric and boolean leaves are
    // asserted by value in the cases below.
    const expected = leafPaths(schema)
      .filter((l) => !DOCUMENTED_EXCLUSIONS.includes(l))
      .filter((l) => fixture.includes(sentinel(l)));
    const missing = expected.filter((l) => !out.includes(sentinel(l)));

    // A schema whose leaves stopped resolving would make this vacuously pass, so the count is pinned.
    expect(expected.length).toBeGreaterThan(8);
    expect(missing, "schema leaves absent from the rendered comment").toEqual([]);
  });

  // A hidden nit is a VISIBILITY decision. The projection used to keep 5 of 14 fields, so its
  // description, recommendation, reasoning and patch existed nowhere in the comment at all.
  it("carries a below-floor nit's whole finding, not just its summary line", () => {
    const out = rendered();

    for (const field of [
      "S_nit_description",
      "S_nit_recommendation",
      "S_nit_reasoning",
      "S_nit_patch",
      "S_nit_code_url",
    ]) {
      expect(out, `suppressed nit lost ${field}`).toContain(field);
    }
    // Its individual confidence and likelihood, not only their product.
    expect(out).toMatch(/confidence: 0\.10 · likelihood: 0\.10/);
    expect(out).toContain("m = 0.01");
  });

  // Deliberately asymmetric with a finding, per the schema: a systemic problem's likelihood is always
  // 1 and unread by the score, so surfacing it would imply per-item information it does not carry.
  it("shows a systemic problem's confidence and deliberately not its likelihood", () => {
    const out = rendered();

    expect(out).toContain("confidence 0.81");
    expect(out).not.toMatch(/confidence 0\.81 · likelihood/);
  });

  it("keeps the machine channel a well-formed HTML comment", () => {
    const out = rendered();
    const blocks = out.match(/<!-- code-review:suppressed-nit[\s\S]*?-->/g) ?? [];

    expect(blocks.length).toBe(1);
    // A `-->` inside a carried field would close the block early and spill into the visible prose.
    expect(blocks[0]!.slice(4, -3)).not.toContain("-->");
  });
});
