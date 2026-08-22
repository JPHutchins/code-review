import { describe, it, expect } from "vitest";
import { readRepoFile, repoFiles, WORKFLOW_EXTENSIONS } from "./test-util.js";

// Every key that carries a model id into the agent CLI: the reusables' inputs, and the env vars a
// standalone workflow sets directly. This list and the scanned directories below are the guard's
// closed boundary — a model id reaching the CLI through a key that is not named here, or from a
// file outside those directories, is not policed. Add the key here when you add the wiring.
const MODEL_CONFIG_KEYS = [
  "model_full",
  "model_mechanic",
  "subagent_model",
  "opus_model",
  "sonnet_model",
  "haiku_model",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "SUBAGENT_MODEL",
] as const;

type ConfiguredModel = { readonly key: string; readonly value: string };

// The ids a value can resolve to. A workflow expression forwards someone else's id — checked where
// that id is written — but it can also embed literals, which are ids configured here. Comparison
// operands are dropped first: in `conclusion == 'success' && 'a-model' || 'another'`, only the
// branches can reach ANTHROPIC_MODEL.
const modelIdsIn = (value: string): readonly string[] =>
  value.startsWith("${{")
    ? [...value.replace(/(?:==|!=)\s*'[^']*'/g, "").matchAll(/'([^']+)'/g)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      )
    : [value];

// A literal assignment to one of those keys, whether live or commented out — a commented example is
// config a consumer uncomments.
const configuredModels = (relativePath: string): readonly ConfiguredModel[] =>
  readRepoFile(relativePath)
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(?:#\s*)?([A-Za-z_]+):[ \t]+(\S.*?)\s*(?:#.*)?$/.exec(line);
      const [, key = "", value = ""] = match ?? [];
      return MODEL_CONFIG_KEYS.some((modelKey) => modelKey === key)
        ? modelIdsIn(value).map((id) => ({ key, value: id }))
        : [];
    });

const searched = [
  ...repoFiles(".github/workflows"),
  ...repoFiles("examples/workflows", [...WORKFLOW_EXTENSIONS, ".md"]),
] as const;

const surfaces = searched.filter((path) => configuredModels(path).length > 0);

// Every model this project configures has a 1M context window, but the agent CLI assumes 200k for
// any id it does not recognize and starts compacting the review's own evidence away well before
// that. The `[1m]` suffix is what corrects it, and dropping the suffix fails silently — no error,
// just a reviewer with a shorter memory — so the declaration is pinned here rather than left to
// review vigilance. Surfaces are discovered by scanning for the config keys, so a new workflow file
// or a model from another family cannot slip past an allowlist; the discovered set is then asserted,
// so config going missing cannot quietly shrink the coverage either.
describe("1M context window declaration (#157)", () => {
  it("covers exactly the surfaces that configure a model", () => {
    expect(surfaces).toEqual([
      ".github/workflows/review-on-comment.yaml",
      ".github/workflows/review-selftest.yaml",
      ".github/workflows/review.yaml",
      "examples/workflows/README.md",
      "examples/workflows/review-on-comment.yaml",
      "examples/workflows/review.yaml",
    ]);
  });

  for (const path of surfaces) {
    it(`${path} declares [1m] on every model id it configures`, () => {
      expect(
        configuredModels(path)
          .filter((configured) => !configured.value.endsWith("[1m]"))
          .map((configured) => `${configured.key}: ${configured.value}`),
      ).toEqual([]);
    });
  }
});
