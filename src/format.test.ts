import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatMarkdown } from "./format.js";
import { render } from "./render.js";
import type { Findings, ResultEnvelope, PriceMap, ModelUsageEntry } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(__dirname, "..", "templates", "comment.eta"), "utf-8");

const mkFindings = (overrides?: Partial<Findings>): Findings => ({
  schema_version: "0.4.0",
  summary: "A test summary.",
  verdict: "comment",
  findings: [],
  ...overrides,
});

const mkEntry = (overrides: Partial<ModelUsageEntry>): ModelUsageEntry => ({
  model: "model-a",
  input_tokens: 10000,
  output_tokens: 2000,
  cache_read_tokens: 5000,
  cache_write_tokens: 1000,
  ...overrides,
});

/** Longest prefix of `items` for which `predicate` holds — mirrors render.test.ts's helper. */
const takeWhile = <T>(items: readonly T[], predicate: (item: T) => boolean): T[] => {
  const stopIndex = items.findIndex((item) => !predicate(item));
  return stopIndex === -1 ? [...items] : items.slice(0, stopIndex);
};

/** The contiguous run of lines starting at the first line matching `start`, while `keep` holds. */
const contiguousBlockFrom = (
  markdown: string,
  start: (line: string) => boolean,
  keep: (line: string) => boolean,
): string[] => {
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex(start);
  return startIndex === -1 ? [] : takeWhile(lines.slice(startIndex), keep);
};

describe("formatMarkdown", () => {
  it("collapses 3+ consecutive blank lines to a single blank line", () => {
    expect(formatMarkdown("a\n\n\n\nb\n")).toBe("a\n\nb\n");
  });

  it("preserves a single blank line", () => {
    expect(formatMarkdown("a\n\nb\n")).toBe("a\n\nb\n");
  });

  it("never collapses a blank line to zero (a single separator must survive)", () => {
    expect(formatMarkdown("a\n\nb\n")).toContain("a\n\nb");
  });

  it("trims trailing whitespace on each line", () => {
    expect(formatMarkdown("a   \nb\t\n")).toBe("a\nb\n");
  });

  it("ensures exactly one trailing newline", () => {
    expect(formatMarkdown("a\n\n\n\n")).toBe("a\n");
    expect(formatMarkdown("a")).toBe("a\n");
    expect(formatMarkdown("a\n")).toBe("a\n");
  });

  it("preserves blank lines and trailing whitespace inside a fenced block verbatim", () => {
    const input = "before\n\n\n```suggestion\nline1   \n\n\nline2\n```\n\n\nafter\n";
    expect(formatMarkdown(input)).toBe(
      "before\n\n```suggestion\nline1   \n\n\nline2\n```\n\nafter\n",
    );
  });

  it("does not reflow or alter non-blank content outside a fence", () => {
    const input = "# Title\n\nSome *markdown* with `code` and a [link](https://x).\n";
    expect(formatMarkdown(input)).toBe(input);
  });

  it("keeps the sticky's cost table contiguous after formatting (regression guard)", () => {
    const pricesMulti: PriceMap = {
      _updated: "2026-07-03",
      _unit: "USD per 1M tokens",
      models: {
        "model-a": { in: 3.0, out: 15.0, cache_read: 0.3, cache_write: 0.6 },
        "model-b": { in: 1.0, out: 5.0, cache_read: 0.1, cache_write: 0.2 },
        "model-c": { in: 0.5, out: 2.5, cache_read: 0.05, cache_write: 0.1 },
      },
    };
    const multiModelEnvelope: ResultEnvelope = {
      schema_version: "0.4.0",
      findings: mkFindings(),
      models: [
        mkEntry({ model: "model-a" }),
        mkEntry({ model: "model-b", input_tokens: 20000, output_tokens: 3000 }),
        mkEntry({ model: "model-c", input_tokens: 5000, output_tokens: 500 }),
      ],
      turns: 1,
      duration_ms: 30000,
    };

    const raw = render({
      findings: mkFindings(),
      envelope: multiModelEnvelope,
      prices: pricesMulti,
      template,
    });
    const formatted = formatMarkdown(raw);

    const block = contiguousBlockFrom(
      formatted,
      (line) => line.startsWith("> | Model |"),
      (line) => line.startsWith("> |"),
    );
    // header + separator + 3 model rows + Total row, all contiguous — formatMarkdown only
    // removes blank lines, never inserts one, so a contiguous table survives unbroken.
    expect(block).toHaveLength(1 + 1 + 3 + 1);
    expect(block.every((line) => line.trim().length > 0)).toBe(true);
    expect(block.at(-1)).toMatch(/^> \| \*\*Total\*\*/);
  });
});
