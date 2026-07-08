import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseJsonl, sumTranscriptUsage, readTranscriptTree } from "./transcript.js";

const fixtureDir = resolve(__dirname, "..", "test", "fixtures", "transcript");
const fixture = (...segments: string[]): string => resolve(fixtureDir, ...segments);

describe("parseJsonl", () => {
  it("parses one object per non-blank line", () => {
    expect(parseJsonl('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("drops blank lines and a truncated (unparseable) final line rather than throwing", () => {
    expect(parseJsonl('{"a":1}\n\n  \n{"b":2}\n{"c":3')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns [] for empty input", () => {
    expect(parseJsonl("")).toEqual([]);
  });
});

describe("sumTranscriptUsage", () => {
  it("sums a real DeepSeek transcript per model (deduped by message.id), with the CC→abstract cache-field rename", () => {
    const usage = sumTranscriptUsage(
      parseJsonl(readFileSync(fixture("deepseek-main.jsonl"), "utf-8")),
    );
    // 4 assistant lines but 2 distinct message.id (each logged twice) — summed once each.
    expect(usage.models).toEqual([
      {
        model: "deepseek-v4-pro",
        input_tokens: 21615,
        output_tokens: 107,
        cache_read_tokens: 21504,
        cache_write_tokens: 0,
      },
    ]);
    expect(usage.turns).toBe(2);
    expect(usage.durationMs).toBe(12856);
    expect(usage.firstTsMs).toBe(Date.parse("2026-07-08T20:22:08.326Z"));
    expect(usage.lastTsMs).toBe(Date.parse("2026-07-08T20:22:21.182Z"));
  });

  it("counts a message logged across multiple lines once (dedup by message.id), but keeps id-less lines", () => {
    const dup = {
      type: "assistant",
      message: { id: "msg_1", model: "pro", usage: { input_tokens: 100, output_tokens: 10 } },
    };
    const entries = [
      dup,
      dup, // same message.id — a second content-block line of the same turn
      {
        type: "assistant",
        message: { id: "msg_2", model: "pro", usage: { input_tokens: 5, output_tokens: 1 } },
      },
      // no id: cannot be de-duplicated, so counted as-is
      {
        type: "assistant",
        message: { model: "pro", usage: { input_tokens: 7, output_tokens: 2 } },
      },
    ];
    const usage = sumTranscriptUsage(entries);
    expect(usage.models[0]).toMatchObject({ model: "pro", input_tokens: 112, output_tokens: 13 });
    expect(usage.turns).toBe(3);
  });

  it("sums each model separately, preserving first-appearance order", () => {
    const entries = [
      {
        type: "assistant",
        message: { model: "pro", usage: { input_tokens: 10, output_tokens: 1 } },
      },
      {
        type: "assistant",
        message: { model: "flash", usage: { input_tokens: 5, output_tokens: 2 } },
      },
      {
        type: "assistant",
        message: { model: "pro", usage: { input_tokens: 20, output_tokens: 3 } },
      },
    ];
    const usage = sumTranscriptUsage(entries);
    expect(usage.models.map((m) => m.model)).toEqual(["pro", "flash"]);
    expect(usage.models[0]).toMatchObject({ model: "pro", input_tokens: 30, output_tokens: 4 });
    expect(usage.models[1]).toMatchObject({ model: "flash", input_tokens: 5, output_tokens: 2 });
    expect(usage.turns).toBe(3);
  });

  it("ignores non-assistant lines and assistant lines with no usage/model", () => {
    const entries = [
      { type: "user", message: { content: "hi" } },
      { type: "assistant", message: { model: "pro" } }, // no usage
      { type: "assistant", message: { usage: { input_tokens: 9, output_tokens: 9 } } }, // no model
      {
        type: "assistant",
        message: { model: "pro", usage: { input_tokens: 7, output_tokens: 1 } },
      },
    ];
    const usage = sumTranscriptUsage(entries);
    expect(usage.models).toEqual([
      {
        model: "pro",
        input_tokens: 7,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    ]);
    expect(usage.turns).toBe(1);
  });

  it("treats a non-numeric or negative token field as zero, never poisoning the sum", () => {
    const entries = [
      {
        type: "assistant",
        message: {
          model: "pro",
          usage: { input_tokens: "lots", output_tokens: -5, cache_read_input_tokens: NaN },
        },
      },
    ];
    expect(sumTranscriptUsage(entries).models[0]).toEqual({
      model: "pro",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
  });

  it("returns empty usage and null bounds for no entries", () => {
    const usage = sumTranscriptUsage([]);
    expect(usage.models).toEqual([]);
    expect(usage.turns).toBe(0);
    expect(usage.durationMs).toBe(0);
    expect(usage.firstTsMs).toBeNull();
    expect(usage.lastTsMs).toBeNull();
  });
});

describe("readTranscriptTree", () => {
  it("reads a present main transcript with no siblings", () => {
    const tree = readTranscriptTree(fixture("deepseek-main.jsonl"));
    expect(tree.missing).toBe(false);
    expect(tree.files).toEqual([fixture("deepseek-main.jsonl")]);
    expect(sumTranscriptUsage(tree.entries).turns).toBe(2);
  });

  it("reports missing (never throws) for an unreadable main transcript", () => {
    const tree = readTranscriptTree(fixture("does-not-exist.jsonl"));
    expect(tree.missing).toBe(true);
    expect(tree.entries).toEqual([]);
    expect(tree.files).toEqual([]);
  });

  it("adds sibling subagents/*.jsonl when the main transcript has no inline sidechain turns", () => {
    const tree = readTranscriptTree(fixture("with-subagents", "main.jsonl"));
    expect(tree.files).toHaveLength(2);
    const usage = sumTranscriptUsage(tree.entries);
    expect(usage.models.map((m) => m.model).sort()).toEqual(["alpha", "beta"]);
    expect(usage.turns).toBe(2);
  });

  it("does NOT read siblings when the main transcript already inlines sidechain turns (no double count)", () => {
    const tree = readTranscriptTree(fixture("inline-sidechain", "main.jsonl"));
    expect(tree.files).toEqual([fixture("inline-sidechain", "main.jsonl")]);
    const usage = sumTranscriptUsage(tree.entries);
    expect(usage.models.map((m) => m.model).sort()).toEqual(["alpha", "beta"]);
    expect(usage.models.some((m) => m.model === "gamma")).toBe(false);
    expect(usage.turns).toBe(2);
  });
});
