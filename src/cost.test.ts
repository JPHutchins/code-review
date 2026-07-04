import { describe, it, expect, vi } from "vitest";
import { computeCost } from "./cost.js";
import type { PriceMap, ModelUsageEntry } from "./schema.js";

const prices: PriceMap = {
  _updated: "2026-07-03",
  _unit: "USD per 1M tokens",
  models: {
    "pro-model": { in: 1.1, out: 4.4, cache_read: 0.14, cache_write: 0.28 },
    "flash-model": { in: 0.27, out: 1.1, cache_read: 0.07, cache_write: 0.14 },
  },
};

const mkEntry = (overrides: Partial<ModelUsageEntry>): ModelUsageEntry => ({
  model: "pro-model",
  input_tokens: 0,
  output_tokens: 0,
  ...overrides,
});

describe("computeCost", () => {
  it("computes cost for a single model including cache_write", () => {
    const report = computeCost(
      [
        mkEntry({
          model: "pro-model",
          input_tokens: 100_000,
          output_tokens: 10_000,
          cache_read_tokens: 50_000,
          cache_write_tokens: 25_000,
        }),
      ],
      prices,
    );

    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]!.model).toBe("pro-model");
    expect(report.lines[0]!.costUSD).toBeCloseTo(
      (100_000 * 1.1 + 10_000 * 4.4 + 50_000 * 0.14 + 25_000 * 0.28) / 1_000_000,
      5,
    );
    expect(report.totalCostUSD).toBeCloseTo(report.lines[0]!.costUSD, 5);
    expect(report.totalCacheWriteTokens).toBe(25_000);
  });

  it("computes across multiple models", () => {
    const report = computeCost(
      [
        mkEntry({
          model: "pro-model",
          input_tokens: 84201,
          output_tokens: 6540,
          cache_read_tokens: 61020,
          cache_write_tokens: 0,
        }),
        mkEntry({
          model: "flash-model",
          input_tokens: 12880,
          output_tokens: 1110,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        }),
      ],
      prices,
    );

    expect(report.lines).toHaveLength(2);
    expect(report.totalInputTokens).toBe(84201 + 12880);
    expect(report.totalOutputTokens).toBe(6540 + 1110);
    expect(report.totalCostUSD).toBeCloseTo(report.lines[0]!.costUSD + report.lines[1]!.costUSD, 5);
  });

  it("warns on unknown models via the warn callback (not silent zero)", () => {
    const warn = vi.fn();
    const report = computeCost(
      [mkEntry({ model: "unknown-model", input_tokens: 100_000, output_tokens: 10_000 })],
      prices,
      warn,
    );

    expect(report.lines[0]!.costUSD).toBe(0);
    expect(report.lines[0]!.model).toBe("unknown-model");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown-model"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("price map"));
  });

  it("defaults to process.stderr.write for warnings when no warn callback is provided", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const report = computeCost(
        [mkEntry({ model: "unknown-model", input_tokens: 1, output_tokens: 1 })],
        prices,
      );
      expect(report.lines[0]!.costUSD).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("unknown-model"));
    } finally {
      spy.mockRestore();
    }
  });

  it("does NOT warn for known models", () => {
    const warn = vi.fn();
    computeCost(
      [mkEntry({ model: "pro-model", input_tokens: 100, output_tokens: 10, cache_read_tokens: 5 })],
      prices,
      warn,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns zero totals for empty models array", () => {
    const warn = vi.fn();
    const report = computeCost([], prices, warn);

    expect(report.lines).toHaveLength(0);
    expect(report.totalCostUSD).toBe(0);
    expect(report.totalInputTokens).toBe(0);
    expect(report.totalOutputTokens).toBe(0);
    expect(report.totalCacheReadTokens).toBe(0);
    expect(report.totalCacheWriteTokens).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats missing cache_read_tokens/cache_write_tokens as zero", () => {
    const warn = vi.fn();
    const report = computeCost(
      [mkEntry({ model: "pro-model", input_tokens: 100_000, output_tokens: 10_000 })],
      prices,
      warn,
    );
    expect(report.lines[0]!.cacheReadTokens).toBe(0);
    expect(report.lines[0]!.cacheWriteTokens).toBe(0);
    expect(report.lines[0]!.costUSD).toBeCloseTo((100_000 * 1.1 + 10_000 * 4.4) / 1_000_000, 5);
  });

  it("handles large token counts without overflow", () => {
    const report = computeCost(
      [
        mkEntry({
          model: "pro-model",
          input_tokens: 1_000_000_000,
          output_tokens: 500_000_000,
          cache_read_tokens: 2_000_000_000,
          cache_write_tokens: 1_000_000_000,
        }),
      ],
      prices,
    );

    expect(report.totalInputTokens).toBe(1_000_000_000);
    expect(report.lines[0]!.costUSD).toBeGreaterThan(0);
    expect(Number.isFinite(report.lines[0]!.costUSD)).toBe(true);
  });

  it("handles zero token counts correctly", () => {
    const report = computeCost(
      [
        mkEntry({
          model: "pro-model",
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        }),
      ],
      prices,
    );

    expect(report.totalInputTokens).toBe(0);
    expect(report.totalCostUSD).toBe(0);
  });

  it("returns zero cost when all model prices are zero", () => {
    const zeroPrices: PriceMap = {
      _updated: "2026-07-03",
      _unit: "USD per 1M tokens",
      models: {
        "pro-model": { in: 0, out: 0, cache_read: 0, cache_write: 0 },
      },
    };
    const report = computeCost(
      [
        mkEntry({
          model: "pro-model",
          input_tokens: 100_000,
          output_tokens: 10_000,
          cache_read_tokens: 50_000,
          cache_write_tokens: 5_000,
        }),
      ],
      zeroPrices,
    );

    expect(report.totalCostUSD).toBe(0);
    expect(report.lines[0]!.costUSD).toBe(0);
  });
});
