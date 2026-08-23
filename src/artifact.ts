import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseFindingsMarker } from "./surface.js";

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
      // The member is located by NAME, not assumed at the root. `unzip -p <zip> findings.json`
      // pattern-matches the full stored path, so it exits 11 ("filename not matched") if the archive
      // ever nests as `findings/findings.json` — and that failure is silent: the catch below returns
      // null, so every re-review would seed cold and the nit stickiness would always fail open with
      // nothing in the log. Today's upload-artifact strips the directory prefix (verified against a
      // real archive), but that is its behaviour, not ours.
      const { stdout: listing } = await run("unzip", ["-Z1", zip], {
        encoding: "utf-8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: STEP_TIMEOUT_MS,
      });
      const member = listing
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l === "findings.json" || l.endsWith("/findings.json"));
      if (member === undefined) return null;
      // maxBuffer because a findings document on a long PR is comfortably past node's 1MiB default.
      const { stdout } = await run("unzip", ["-p", zip, member], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: STEP_TIMEOUT_MS,
      });
      return stdout;
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
    return JSON.parse(text);
  } catch {
    return null;
  }
};
