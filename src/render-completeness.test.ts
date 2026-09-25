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
  const leaves: string[] = [];
  const props = n["properties"];
  if (props !== undefined && typeof props === "object") {
    leaves.push(
      ...Object.entries(props as Record<string, unknown>).flatMap(([k, v]) => {
        const here = path === "" ? k : `${path}.${k}`;
        const deeper = leafPaths(v, here);
        return deeper.length > 0 ? deeper : [here];
      }),
    );
  }
  const items = n["items"];
  if (items !== undefined) leaves.push(...leafPaths(items, path));
  // A map-typed node's VALUE shape is a leaf too, keyed `*` (the keys are arbitrary). The walker
  // previously stopped at properties/items, so a leaf under additionalProperties never entered
  // inScope — a field added next month under a map node dodged the guard entirely (issue #217
  // review r7). patternProperties records the pattern instead of `*`.
  const additional = n["additionalProperties"];
  if (additional !== undefined && typeof additional === "object") {
    const deeper = leafPaths(additional, `${path}.*`);
    leaves.push(...(deeper.length > 0 ? deeper : [`${path}.*`]));
  }
  const pattern = n["patternProperties"];
  if (pattern !== undefined && typeof pattern === "object") {
    for (const [pat, v] of Object.entries(pattern as Record<string, unknown>)) {
      const deeper = leafPaths(v, `${path}.<${pat}>`);
      leaves.push(...(deeper.length > 0 ? deeper : [`${path}.<${pat}>`]));
    }
  }
  return leaves;
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
const DOCUMENTED_EXCLUSIONS = [
  "scope_metastasis.decision_prompt",
  "systemic_problems.likelihood",
  // Metadata about the machine document rather than review content: the document in the artifact
  // carries it, and the directive tells a reader to take the version FROM that document.
  "schema_version",
];

// Delimited with a suffix so no sentinel is a substring of another: `S_findings_id` sits inside
// `S_findings_id_url`, which passed the id leaves via the code_url sentinel while the id fields
// themselves rendered nowhere and were asserted nowhere (issue #217 review r7).
const sentinel = (leaf: string): string => `S_${leaf.replace(/\./g, "_")}_E`;

// Leaves whose type cannot carry a string sentinel. ONE table per concern: the leaf names are the
// allowlist the schema walk accepts, and each entry pairs the value the render must contain with the
// anchor naming the LINE the leaf's own field renders on — a sibling sentinel or fixed prose on that
// surface. So a leaf cannot be listed here to excuse it from the walk without also being asserted,
// and a value cannot pass by rendering somewhere else in the comment: the previous presence search
// let `verdict: "comment"` match the directive's own static prose, and a bare "3" match
// change_size's "333" while the metastasis note rendered nothing (issue #232, #217 review r7).
const VISIBLE_LEAVES: readonly (readonly [leaf: string, value: string, anchor: string])[] = [
  // The verdict anchor is the markdown header prefix, NOT a fragment of the value itself: a value
  // containing its own anchor reduces the position check to the presence check it replaces — a
  // badge moved off the header would still pass (issue #232 r1). The first "## " line IS the
  // verdict badge (the systemic and findings headers render later in the template).
  ["verdict", "💬 comment", "## "],
  ["findings.start_line", ":10", "S_findings_title_E"],
  ["findings.end_line", "–12", "S_findings_title_E"],
  ["findings.side", "RIGHT", "S_findings_title_E"],
  ["findings.severity", "(major)", "S_findings_title_E"],
  ["findings.confidence", "0.91", "S_findings_id_E"],
  ["findings.likelihood", "0.92", "S_findings_id_E"],
  ["systemic_problems.severity", "(critical)", "S_systemic_problems_title_E"],
  ["systemic_problems.confidence", "0.81", "S_systemic_problems_id_E"],
  ["change_size.code.added", "111", "**Changes:**"],
  ["change_size.code.removed", "222", "**Changes:**"],
  ["change_size.tests.added", "333", "**Changes:**"],
  ["change_size.tests.removed", "444", "**Changes:**"],
  ["change_size.docs.added", "555", "**Changes:**"],
  ["change_size.docs.removed", "666", "**Changes:**"],
  // The anchor is the flagged-code line's blockquote code-span opening ("> **`"), the only line in
  // the note that carries it — the INTRO line is near-duplicate prose ("each fix keeps enabling the
  // next finding in that machinery"), so any prose fragment ("consecutive rounds", " findings in ")
  // is one wording edit away from colliding with it (issue #232 r1).
  ["scope_metastasis.recurring.id", "`recurring-code`", "> **`"],
  ["scope_metastasis.recurring.consecutive_rounds", "in 3 consecutive rounds", "> **`"],
];

// These live ONLY in the compact convergence marker. They are asserted by the golden pin below —
// exact JSON equality against the fixture's convergence object, not substring search: searching was
// prefix-loose (`"round":1` is contained in `"round":10`, `"score":0.71` in 0.712), so the guard
// reported green on the exact numeric drift it exists to catch. The table only lists which leaves
// are numeric/derived so the fixture-coverage check knows a sentinel cannot stand in for them.
const CONVERGENCE_LEAF_VALUES: Readonly<Record<string, string>> = {
  "convergence.score": '"score":0.71',
  "convergence.threshold": '"threshold":1',
  "convergence.converged": '"converged":true',
  "convergence.rounds.round": '"round":1',
  "convergence.rounds.score": '"score":0.71',
  "convergence.rounds.ids.*": '"sys-code"',
  "convergence.rounds.sha": '"sha":"abc123def456"',
  "scope_metastasis.recurring.start_round": '"round":1',
  // Derived from the trajectory's codes rather than rendered as prose, so the marker is where it lives.
  "scope_metastasis.recurring.id": '"recurring-code"',
};

const NUMERIC_LEAVES = [
  ...VISIBLE_LEAVES.map(([leaf]) => leaf),
  ...Object.keys(CONVERGENCE_LEAF_VALUES),
];

const findings = {
  schema_version: "0.9.0",
  summary: sentinel("summary"),
  verdict: "comment",
  systemic_problems: [
    {
      title: sentinel("systemic_problems.title"),
      description: sentinel("systemic_problems.description"),
      severity: "critical",
      reasoning: sentinel("systemic_problems.reasoning"),
      confidence: 0.81,
      likelihood: 0.82,
      id: sentinel("systemic_problems.id"),
      code_url: `https://example.com/${sentinel("systemic_problems.code_url")}`,
      finding_ids: [sentinel("systemic_problems.finding_ids")],
      paths: [`src/${sentinel("systemic_problems.paths")}.ts`],
    },
  ],
  scope_metastasis: {
    decision_prompt: sentinel("scope_metastasis.decision_prompt"),
    recurring: [{ id: "recurring-code", consecutive_rounds: 3, start_round: 1 }],
  },
  convergence: {
    score: 0.71,
    threshold: 1,
    converged: true,
    // The recurring id MUST appear in three CONSECUTIVE rounds' ids: scope_metastasis is derived
    // from the round history, so the note only fires (and its rendered values only exist to assert)
    // when the fixture gives it a genuine streak — a one-round fixture rendered no note at all
    // (issue #217 review r7). The shas are distinct: a same-sha round is a CI retry, which the
    // streak detector collapses rather than counts.
    rounds: [
      { round: 1, score: 0.71, ids: { "sys-code": 1, "recurring-code": 3 }, sha: "abc123def456" },
      { round: 2, score: 0.71, ids: { "recurring-code": 3 }, sha: "abc123def457" },
      { round: 3, score: 0.71, ids: { "recurring-code": 3 }, sha: "abc123def458" },
    ],
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
      id: sentinel("findings.id"),
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
      id: "S_nit_id",
      code_url: "https://example.com/S_nit_url",
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

// Everything the comment carries, machine channels included: the compact convergence marker is
// base64, so a literal search of the rendered text alone reports its contents missing when they are
// simply encoded. Decoding it here is why the guard can tell "absent" from "encoded".
const decodedConvergence = (): string => {
  const conv = /code-review:convergence;base64 (\S+) -->/.exec(rendered())?.[1];
  return conv === undefined ? "" : Buffer.from(conv, "base64").toString("utf-8");
};

const carriedText = (): string => `${rendered()}\n${decodedConvergence()}`;

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
    const out = carriedText();
    const fixture = JSON.stringify(findings);
    const inScope = leafPaths(schema).filter((l) => !DOCUMENTED_EXCLUSIONS.includes(l));

    // FIRST: the fixture must cover the schema. Filtering the walk down to leaves the fixture happens
    // to mention is how a field added next month dodges it — the hole my previous version had. A leaf
    // with no sentinel and no numeric stand-in fails HERE, so the fixture cannot fall behind quietly.
    const uncovered = inScope.filter(
      (l) => !fixture.includes(sentinel(l)) && !NUMERIC_LEAVES.includes(l),
    );
    expect(uncovered, "schema leaves the fixture does not cover — add them to it").toEqual([]);

    // A schema that stopped resolving would leave inScope empty and pass everything vacuously.
    expect(inScope.length).toBeGreaterThan(20);

    // THEN: every sentinel the fixture carries must reach the rendered comment.
    const missing = inScope
      .filter((l) => fixture.includes(sentinel(l)))
      .filter((l) => !out.includes(sentinel(l)));
    expect(missing, "schema leaves absent from the rendered comment").toEqual([]);
  });

  // The numeric and boolean leaves, which cannot carry a string sentinel — asserted by value, and
  // listed by name so the walk above can tell "covered numerically" from "not covered at all".
  it("renders a value for every leaf the allowlist excuses from the sentinel walk", () => {
    const lines = rendered().split("\n");

    for (const [leaf, value, anchor] of VISIBLE_LEAVES) {
      const line = lines.find((l) => l.includes(anchor)) ?? "";
      expect(line, `${leaf} (${value}) on the ${anchor} line`).toContain(value);
    }
    // Within-line attribution: the six change_size values share one anchor line, so per-value
    // containment cannot catch a swapped pair — assert the rendered cell ORDER (issue #232 r1).
    const changesLine = lines.find((l) => l.includes("**Changes:**")) ?? "";
    expect(changesLine).toContain("+111 / −222 code · +333 / −444 tests · +555 / −666 docs");
  });

  it("carries every convergence leaf in the compact marker itself", () => {
    const decoded = decodedConvergence();
    expect(decoded, "no compact convergence marker in the comment").not.toBe("");
    // The golden pin: the decoded marker must EQUAL the fixture's convergence object — every leaf
    // (score, threshold, converged, each round's number/score/sha, the map-typed codes) asserted
    // exactly, not substring-searched. The map leaf enters the walk via `.*`; this pin is what
    // asserts its value.
    expect(JSON.parse(decoded)).toEqual(findings.convergence);
  });

  // A hidden nit is a VISIBILITY decision. The projection used to keep 5 of 14 fields, so its
  // description, recommendation, reasoning and patch existed nowhere in the comment at all.
  it("carries a below-floor nit's whole finding, not just its summary line", () => {
    const out = rendered();

    for (const field of [
      "S_nit_id",
      "S_nit_description",
      "S_nit_recommendation",
      "S_nit_reasoning",
      "S_nit_patch",
      "S_nit_url",
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

  // Carrying every hidden nit's whole finding puts unbounded text in the ONE comment whose 65536-char
  // limit post deliberately does not shed — an oversized body 422s the round with the announce
  // placeholder still up. Removing the ~32KB document bought far more room than this spends, but that
  // is not a bound, so each field is clipped and the clip is visible rather than silent.
  it("clips a carried field instead of putting unbounded text in the comment", () => {
    const huge = {
      ...findings,
      findings: [findings.findings[0]!, { ...findings.findings[1]!, reasoning: "z".repeat(9000) }],
    } as unknown as Findings;
    const out = render({
      findings: huge,
      envelope: {
        schema_version: "0.4.0",
        findings: huge,
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
      strays: huge.findings.slice(0, 1),
      suppressedNits: huge.findings.slice(1, 2),
      nitVisibilityFloor: 0.25,
      jsonUrl: "https://example.com/artifact.zip",
    });

    expect(out).toContain("… [truncated]");
    expect(out.split("z".repeat(500)).length - 1).toBeLessThan(9000 / 500);
  });

  it("keeps the machine channel a well-formed HTML comment", () => {
    const out = rendered();
    const blocks = out.match(/<!-- code-review:suppressed-nit[\s\S]*?-->/g) ?? [];

    expect(blocks.length).toBe(1);
    // A `-->` inside a carried field would close the block early and spill into the visible prose.
    expect(blocks[0]!.slice(4, -3)).not.toContain("-->");
  });

  // The neutralizer is a zero-width space: `-->` in the location path or a carried field becomes
  // `--\u200B>` — the block stays well-formed AND a human reads the author's text verbatim (the
  // previous neutralizer mutated it to a visible hyphen; issue #217 review r7).
  it("a `-->` in a suppressed nit's path or fields cannot spill the machine block, and the text stays verbatim", () => {
    const hostileNit = {
      ...findings.findings[1]!,
      path: "src/a-->b.ts",
      description: "keeps --> verbatim",
    };
    const hostileDoc = {
      ...findings,
      findings: [findings.findings[0]!, hostileNit],
    } as unknown as Findings;
    const out = render({
      findings: hostileDoc,
      envelope: {
        schema_version: "0.4.0",
        findings: hostileDoc,
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
      suppressedNits: [hostileNit],
      route: "full review",
      convergenceRound: true,
      nitVisibilityFloor: 0.25,
      jsonUrl: "https://example.com/artifact.zip",
    });

    const blocks = out.match(/<!-- code-review:suppressed-nit[\s\S]*?-->/g) ?? [];
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.slice(4, -3)).not.toContain("-->");
    expect(blocks[0]).toMatch(/location: src.a--.>b.ts:20-22 .RIGHT./);
    expect(blocks[0]).toMatch(/description: keeps --.> verbatim/);
  });

  // Per-field clips bound ONE nit's fields; the sum across a nit-heavy round is unbounded, and the
  // sticky is the comment post deliberately does not shed — the aggregate budget is what keeps the
  // machine block from 422ing it (issue #233 r1).
  it("bounds the carried machine block across a nit-heavy round, marking the cut", () => {
    const manyNits = Array.from({ length: 14 }, (_, i) => ({
      ...findings.findings[1]!,
      reasoning: `r${String(i)} ${"y".repeat(9000)}`,
    }));
    const doc = {
      ...findings,
      findings: [findings.findings[0]!, ...manyNits],
    } as unknown as Findings;
    const out = render({
      findings: doc,
      envelope: {
        schema_version: "0.4.0",
        findings: doc,
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
      suppressedNits: manyNits,
      route: "full review",
      convergenceRound: true,
      nitVisibilityFloor: 0.25,
      jsonUrl: "https://example.com/artifact.zip",
    });

    expect(out.length).toBeLessThan(65_536);
    expect(out).toContain("nit(s) dropped from the sticky");
    expect(out).toContain("r0"); // the first nits' blocks survive
    expect(out).not.toContain("r13"); // the tail's blocks are dropped, marked not silent
    const blocks = out.match(/<!-- code-review:suppressed-nit[\s\S]*?-->/g) ?? [];
    // One block per KEPT nit, plus the clip marker — a dropped nit leaves no block at all.
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.length).toBeLessThan(manyNits.length + 1);
  });

  // The block OVERHEAD is budgeted too: a few hundred accumulated nits must not overflow the
  // sticky even with every carried field in play (issue #233 r5).
  it("bounds a sticky with hundreds of accumulated nits", () => {
    const manyNits = Array.from({ length: 300 }, (_, i) => ({
      ...findings.findings[1]!,
      reasoning: `r${String(i)} ${"y".repeat(200)}`,
    }));
    const doc = {
      ...findings,
      findings: [findings.findings[0]!, ...manyNits],
    } as unknown as Findings;
    const out = render({
      findings: doc,
      envelope: {
        schema_version: "0.4.0",
        findings: doc,
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
      suppressedNits: manyNits,
      route: "full review",
      convergenceRound: true,
      nitVisibilityFloor: 0.25,
      jsonUrl: "https://example.com/artifact.zip",
    });

    expect(out.length).toBeLessThan(65_536);
    expect(out).toContain("dropped from the sticky");
  });

  // A single huge title fits the budget and must be KEPT — the assertion pins the outcome the
  // budget arithmetic decides, so a dropped title term fails it (issue #235).
  it("counts a huge title in the budget and keeps it when it fits", () => {
    const hugeTitle = { ...findings.findings[1]!, title: "T".repeat(20_000) };
    const doc = {
      ...findings,
      findings: [findings.findings[0]!, hugeTitle],
    } as unknown as Findings;
    const out = render({
      findings: doc,
      envelope: {
        schema_version: "0.4.0",
        findings: doc,
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
      suppressedNits: [hugeTitle],
      route: "full review",
      convergenceRound: true,
      nitVisibilityFloor: 0.25,
      jsonUrl: "https://example.com/artifact.zip",
    });

    expect(out).toContain("T".repeat(20_000));
    expect(out).not.toContain("dropped from the sticky");
    expect(out.length).toBeLessThan(65_536);
  });

  // Every sibling field gets escapeCodeBackticks; the code/code_url renders did not — a backtick
  // breaks the inline code span and a paren breaks the markdown link (issue #233 r2).
  it("escapes code and code_url on the stray header", () => {
    const hostile = {
      ...findings.findings[0]!,
      id: "a`b",
      code_url: "https://x/(y)",
    };
    const doc = { ...findings, findings: [hostile] } as unknown as Findings;
    const out = render({
      findings: doc,
      envelope: {
        schema_version: "0.4.0",
        findings: doc,
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
      strays: doc.findings.slice(0, 1),
      suppressedNits: [],
      route: "full review",
      convergenceRound: true,
      nitVisibilityFloor: 0.25,
      jsonUrl: "https://example.com/artifact.zip",
    });

    expect(out).toContain("a-b");
    expect(out).not.toContain("a`b");
    expect(out).toContain("%28y%29");
  });

  // The same-root note lookup is keyed on RAW codes; the escaped display form must not break it
  // for exactly the codes the escaping exists to serve (issue #233 r3).
  it("looks up the same-root note by the raw code, not the escaped display form", () => {
    const noteCode = "a`b";
    const doc = {
      ...findings,
      findings: [{ ...findings.findings[0]!, id: noteCode }],
    } as unknown as Findings;
    const out = render({
      findings: doc,
      envelope: {
        schema_version: "0.4.0",
        findings: doc,
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
      strays: doc.findings.slice(0, 1),
      suppressedNits: [],
      route: "full review",
      convergenceRound: true,
      nitVisibilityFloor: 0.25,
      jsonUrl: "https://example.com/artifact.zip",
      sameRootNotes: { [noteCode]: "Same mechanism as round 1" },
    });

    expect(out).toContain("Same mechanism as round 1");
  });
});

describe("leafPaths — the walker the guard's coverage is built on (issue #217 review r7)", () => {
  it("descends into additionalProperties, recording the map value shape under `*`", () => {
    expect(
      leafPaths(
        { properties: { ids: { type: "object", additionalProperties: { type: "integer" } } } },
        "convergence.rounds",
      ),
    ).toEqual(["convergence.rounds.ids.*"]);
  });

  it("descends into patternProperties, recording the pattern", () => {
    expect(
      leafPaths(
        {
          properties: {
            m: {
              type: "object",
              patternProperties: { "^x": { properties: { n: { type: "integer" } } } },
            },
          },
        },
        "root",
      ),
    ).toEqual(["root.m.<^x>.n"]);
  });

  it("covers the real schema's map-typed leaf — a field under a future map node cannot dodge the walk", () => {
    expect(leafPaths(schema)).toContain("convergence.rounds.ids.*");
  });
});
