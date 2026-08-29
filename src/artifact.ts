import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseConvergenceMarker, parseFindingsMarker } from "./surface.js";

const run = promisify(execFile);

// A hung `gh api` or a stalled `unzip` would wait forever, in a gather step the workflow deliberately
// leaves without a job-level cap. The seed degrades to "no prior findings" on timeout, which is the
// same state as a first round — strictly better than a stuck job.
const STEP_TIMEOUT_MS = 60_000;

// The sticky's marker names the findings artifact rather than carrying it (issue #217). Anything that
// needs a PRIOR round's findings — the re-review seed, the nit-visibility-floor stickiness — resolves
// it through here.
//
// This runs OUTSIDE the reviewing agent's jail, in gather/seed-draft/post, which hold the token. The
// jailed agent is netns-confined to the model host and cannot reach GitHub at all; it receives prior
// findings the same way it always has, through the out-of-band context file seed-draft writes.
const MARKER_URL = /<!-- code-review:findings-json (https?:\/\/[^\s>]+) -->/;

export const findingsArtifactUrl = (body: string): string | null =>
  MARKER_URL.exec(body)?.[1] ?? null;

// The exact stored name of the findings member in `unzip -Z1` output, matched CASE-INSENSITIVELY — a
// case-sensitive filter misses a `Findings.json` member and the seed goes cold with nothing logged
// (issue #217 review r7). Shortest match wins, so a root-level member is preferred over a nested one
// if an archive ever holds both — the pipeline uploads a single directory, so today there is exactly
// one.
export const locateFindingsMember = (listing: string): string | null =>
  listing
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l.toLowerCase() === "findings.json" || l.toLowerCase().endsWith("/findings.json"),
    )
    .sort((a, b) => a.length - b.length)[0] ?? null;

// Reads `findings.json` out of the zip an artifact URL serves. Injected at the call sites so the
// resolver is testable without a network or an unzip binary.
export type ArtifactReader = (zipUrl: string) => Promise<string | null>;

export const readArtifactFindings = (
  ghApiPath: (url: string, outPath: string) => Promise<void>,
): ArtifactReader => {
  return async (zipUrl: string): Promise<string | null> => {
    const dir = await mkdtemp(join(tmpdir(), "code-review-artifact-"));
    const zip = join(dir, "findings.zip");
    try {
      await ghApiPath(zipUrl, zip);
      // The member is located by NAME, not assumed at the root (locateFindingsMember below) — a
      // findings document can nest as `findings/findings.json`, and today's upload-artifact strips the
      // directory prefix (verified against a real archive), but that is its behaviour, not ours.
      const { stdout: listing } = await run("unzip", ["-Z1", zip], {
        encoding: "utf-8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: STEP_TIMEOUT_MS,
      });
      const member = locateFindingsMember(listing);
      if (member === null) return null;
      // Extract ALL members and read the located one by exact filesystem path. `unzip -p <zip>
      // <member>` treats the name as a WILDCARD pattern, so a stored path containing `[`/`]`/`*`/`?`
      // matches nothing, exits 11, and the catch returns null — the exact silent cold-seed the
      // located-name fix exists to prevent (issue #217 review r7, verified empirically on Info-ZIP
      // 6.00). A path read has no pattern semantics at all.
      await run("unzip", [zip, "-d", dir], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: STEP_TIMEOUT_MS,
      });
      return await readFile(join(dir, member), "utf-8");
    } catch {
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
};

// The default reader: `gh api <url> > <path>` — gh follows the artifact redirect and writes the zip.
export const ghArtifactReader = readArtifactFindings(async (url, outPath) => {
  const { stdout } = await run("gh", ["api", url], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    timeout: STEP_TIMEOUT_MS,
  });
  await writeFile(outPath, stdout);
});

// convergence is pipeline-owned, and the artifact holds the agent's draft — uploaded before post stamps
// it — so a fetched document's convergence is the agent ECHOING what the prior seed showed it. The
// sticky's compact marker beside the link is the stamped copy, and replaces the echo here so every
// consumer downstream reads one corrected document. A link with no marker predates the marker and drops
// the echo; priorTrajectory's legacy rounds-marker fallback covers it.
const withoutKey = (doc: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(doc).filter(([k]) => k !== key));

const withStampedConvergence = (doc: unknown, body: string): unknown => {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return doc;
  const stripped = withoutKey(doc as Record<string, unknown>, "convergence");
  const stamped = parseConvergenceMarker(body);
  return stamped === null ? stripped : { ...stripped, convergence: stamped };
};

// A prior sticky's findings document, or null when the body names none and carries none.
//
// The embedded branch is read-only legacy: nothing writes a base64 marker any more, but every sticky
// posted before #217 holds one, and each PR only rewrites its own on its next round — so this branch
// is what keeps those PRs' seeds alive rather than a form we still produce.
export const resolvePriorFindings = async (
  body: string,
  read: ArtifactReader,
): Promise<unknown> => {
  const embedded = parseFindingsMarker(body);
  if (embedded !== null) return embedded;

  const url = findingsArtifactUrl(body);
  if (url === null) return null;

  const text = await read(url);
  if (text === null) return null;
  try {
    return withStampedConvergence(JSON.parse(text), body);
  } catch {
    return null;
  }
};
