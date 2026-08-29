import { describe, it, expect } from "vitest";
import { findingsArtifactUrl, locateFindingsMember, resolvePriorFindings } from "./artifact.js";

// The link branch is the whole point of #217 and nothing exercised it: every other test builds a
// legacy embedded marker, so the regex → fetch → parse path never ran. The reader is injected, so
// these drive it without a network or an unzip binary.
const ARTIFACT = "https://api.github.com/repos/o/r/actions/artifacts/12345/zip";
const linkSticky = `<!-- code-review -->\nprose\n<!-- code-review:findings-json ${ARTIFACT} -->\nmore`;
const embeddedSticky = (doc: unknown): string =>
  `<!-- code-review -->\n<!-- code-review:findings-json;base64 ${Buffer.from(
    JSON.stringify(doc),
    "utf-8",
  ).toString("base64")} -->`;

const never: () => Promise<string | null> = () => {
  throw new Error("the reader must not be consulted");
};

describe("findingsArtifactUrl", () => {
  it("reads the URL a link-form marker names", () => {
    expect(findingsArtifactUrl(linkSticky)).toBe(ARTIFACT);
  });

  it("is null for a legacy embedded marker and for no marker at all", () => {
    expect(findingsArtifactUrl(embeddedSticky({ findings: [] }))).toBeNull();
    expect(findingsArtifactUrl("just prose")).toBeNull();
  });

  // The base64 alphabet has no `:` or `/`, so a payload can never look like a URL — but the regex
  // stops at whitespace and `>` so a marker cannot swallow the rest of the comment either.
  it("stops at the marker's own closing bracket", () => {
    expect(findingsArtifactUrl(`<!-- code-review:findings-json ${ARTIFACT} --> trailing`)).toBe(
      ARTIFACT,
    );
  });
});

describe("resolvePriorFindings", () => {
  // The fetch lives in gather, which holds the repo token; the agentic-review step deliberately has
  // none, because it runs the jailed agent over untrusted PR code. A tokenless `gh api` 401s, the
  // reader returns null, and the seed would go cold on every round with nothing in the log — which is
  // why the resolve happens where the token is and the document is staged to a file.
  it("returns null when the fetch is unauthorized, rather than throwing", async () => {
    const unauthorized = (): Promise<string | null> => Promise.resolve(null);

    expect(await resolvePriorFindings(linkSticky, unauthorized)).toBeNull();
  });

  it("fetches and parses the document a link names", async () => {
    const doc = { schema_version: "0.9.0", summary: "from the artifact", findings: [] };
    const read = (url: string): Promise<string | null> => {
      expect(url).toBe(ARTIFACT);
      return Promise.resolve(JSON.stringify(doc));
    };

    expect(await resolvePriorFindings(linkSticky, read)).toEqual(doc);
  });

  // The legacy branch is why every PR whose sticky predates #217 keeps its seed. It must win without
  // a fetch: those bodies name no artifact, and consulting the reader would be a wasted round trip.
  it("decodes a pre-#217 embedded marker without consulting the reader", async () => {
    const doc = { schema_version: "0.9.0", summary: "embedded", findings: [] };

    expect(await resolvePriorFindings(embeddedSticky(doc), never)).toEqual(doc);
  });

  it("is null when the body names nothing, without consulting the reader", async () => {
    expect(await resolvePriorFindings("prose only", never)).toBeNull();
  });

  // A pruned artifact, a revoked token, a 404: the seed degrades to "no prior findings", which is the
  // same state as a first round. It must never throw into the post path.
  it("degrades to null when the fetch fails", async () => {
    expect(await resolvePriorFindings(linkSticky, () => Promise.resolve(null))).toBeNull();
  });

  // The pathological legacy body: a sticky written before the compact convergence marker existed
  // (#185), so its convergence lives ONLY inside the embedded blob. Nothing beside it carries the
  // trajectory, which is why the embedded branch has to win and has to return the whole document —
  // resolving via the artifact instead would hand back the agent's unstamped copy and lose the
  // trajectory for every such PR still open.
  it("returns a pre-#185 sticky's convergence from the blob, with no compact marker present", async () => {
    const doc = {
      schema_version: "0.9.0",
      summary: "old round",
      findings: [],
      convergence: {
        score: 0.4,
        threshold: 1,
        converged: true,
        rounds: [{ round: 7, score: 0.4 }],
      },
    };
    const body = embeddedSticky(doc);
    expect(body).not.toContain("code-review:convergence");

    const resolved = (await resolvePriorFindings(body, never)) as typeof doc;
    expect(resolved.convergence.rounds).toHaveLength(1);
    expect(resolved.convergence.rounds[0]!.round).toBe(7);
  });

  it("degrades to null when the fetched body is not JSON", async () => {
    expect(
      await resolvePriorFindings(linkSticky, () => Promise.resolve("<html>404</html>")),
    ).toBeNull();
  });
});

// The artifact is the agent's draft, uploaded before post stamps convergence, so a document fetched
// from it can carry the agent's echo of the trajectory it was seeded with. The seed re-derives the
// scope-metastasis streak and the round number from whatever convergence the prior document holds, so
// an echo that outlived its streak would undercount both with nothing else in that path to correct it.
describe("resolvePriorFindings — convergence provenance", () => {
  const stamped = {
    score: 3.94,
    threshold: 1,
    converged: false,
    rounds: [{ round: 7, score: 3.94 }],
  };
  const marker = `<!-- code-review:convergence;base64 ${Buffer.from(
    JSON.stringify(stamped),
    "utf-8",
  ).toString("base64")} -->`;
  const echo = { score: 0.1, threshold: 1, converged: true, rounds: [{ round: 1, score: 0.1 }] };

  it("replaces the artifact's echoed convergence with the sticky's stamped marker", async () => {
    const doc = { schema_version: "0.9.0", findings: [], convergence: echo };
    const resolved = (await resolvePriorFindings(`${linkSticky}\n${marker}`, () =>
      Promise.resolve(JSON.stringify(doc)),
    )) as { convergence: typeof stamped; findings: readonly unknown[] };

    expect(resolved.convergence).toEqual(stamped);
    expect(resolved.findings).toEqual([]);
  });

  it("drops an echo the body does not stamp, rather than trusting it", async () => {
    const doc = { schema_version: "0.9.0", findings: [], convergence: echo };
    const resolved = (await resolvePriorFindings(linkSticky, () =>
      Promise.resolve(JSON.stringify(doc)),
    )) as Record<string, unknown>;

    expect("convergence" in resolved).toBe(false);
  });

  // The embedded blob was written BY post, so its convergence is the stamped one — that branch must
  // keep returning the document untouched.
  it("leaves a legacy embedded document's stamped convergence alone", async () => {
    const doc = { schema_version: "0.9.0", findings: [], convergence: stamped };

    expect(await resolvePriorFindings(embeddedSticky(doc), never)).toEqual(doc);
  });
});

describe("locateFindingsMember (issue #217 review r7)", () => {
  it("finds a root-level member", () => {
    expect(locateFindingsMember("findings.json\n")).toBe("findings.json");
  });

  it("finds a nested member by name", () => {
    expect(locateFindingsMember("findings/findings.json\n")).toBe("findings/findings.json");
  });

  // The case-insensitive match: a `Findings.json` member is the same upload with different casing,
  // and a case-sensitive filter silently cold-seeds it.
  it("matches the member name case-insensitively", () => {
    expect(locateFindingsMember("Findings.json\n")).toBe("Findings.json");
  });

  // `unzip -p <zip> <member>` treated the name as a wildcard pattern — `[prod]` is a character
  // class — so a bracket path exited 11 and cold-seeded. The located name now feeds a filesystem
  // read, which has no pattern semantics; this test pins that such a member is LOCATED at all.
  it("locates a member whose path contains pattern metacharacters", () => {
    expect(locateFindingsMember("artifacts-[prod]/findings.json\n")).toBe(
      "artifacts-[prod]/findings.json",
    );
  });

  it("prefers the shortest member when the archive holds both root and nested copies", () => {
    expect(locateFindingsMember("findings/findings.json\nfindings.json\n")).toBe("findings.json");
  });

  it("is null when no findings member exists", () => {
    expect(locateFindingsMember("readme.md\n")).toBeNull();
  });
});
