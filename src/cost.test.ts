import { describe, it, expect, vi } from "vitest";
import { computeCost, parseInstant } from "./cost.js";
import { PriceMapCodec } from "./schema.js";
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
      undefined,
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
      undefined,
      warn,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns zero totals for empty models array", () => {
    const warn = vi.fn();
    const report = computeCost([], prices, undefined, warn);

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
      undefined,
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

  it("stays provenance-agnostic: an absent map is fed as the bundled all-zero example, so costs are numeric zeros here — the render layer, not computeCost, decides to show N/A (SPEC §6.2)", () => {
    const bundledExampleShaped: PriceMap = {
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
          input_tokens: 84_201,
          output_tokens: 6_540,
          cache_read_tokens: 61_020,
        }),
      ],
      bundledExampleShaped,
    );

    // Token totals are real regardless of the price map — they need no rates.
    expect(report.totalInputTokens).toBe(84_201);
    expect(report.totalOutputTokens).toBe(6_540);
    expect(report.totalCacheReadTokens).toBe(61_020);
    // costUSD is a plain number (0), never a sentinel like "N/A": computeCost has no notion of
    // provenance; the render layer owns the N/A presentation decision.
    expect(typeof report.totalCostUSD).toBe("number");
    expect(report.totalCostUSD).toBe(0);
  });
});

describe("computeCost — UTC time-slot pricing (issue #170)", () => {
  const at = (h: number, m = 0): Date => new Date(Date.UTC(2026, 7, 16, h, m));
  const oneM = (): ModelUsageEntry[] => [
    { model: "slot-model", input_tokens: 1_000_000, output_tokens: 0 },
  ];
  const slotted = (models: PriceMap["models"]): PriceMap => ({
    _updated: "2026-08-16",
    _unit: "USD per 1M tokens",
    models,
  });
  // off-peak wrap 10:00→01:00 (in 1.0), peak 01:00→10:00 (in 2.0) — a 2-slot 24h partition.
  const twoSlot = slotted({
    "slot-model": {
      slots: [
        {
          utc_from: "10:00",
          utc_to: "01:00",
          in: 1.0,
          out: 2.0,
          cache_read: 0.1,
          cache_write: 0.0,
        },
        {
          utc_from: "01:00",
          utc_to: "10:00",
          in: 2.0,
          out: 4.0,
          cache_read: 0.2,
          cache_write: 0.0,
        },
      ],
    },
  });

  it("prices at the PEAK slot for a UTC instant inside it", () => {
    expect(computeCost(oneM(), twoSlot, at(3)).totalCostUSD).toBeCloseTo(2.0, 6);
  });

  it("prices at the OFF-PEAK wrap slot for late-night and past-midnight UTC instants", () => {
    expect(computeCost(oneM(), twoSlot, at(23)).totalCostUSD).toBeCloseTo(1.0, 6);
    expect(computeCost(oneM(), twoSlot, at(0, 30)).totalCostUSD).toBeCloseTo(1.0, 6);
  });

  it("treats utc_from as inclusive and utc_to as exclusive at the boundaries", () => {
    // 01:00 = peak's utc_from (inclusive) → peak; 10:00 = peak's utc_to (exclusive) + the wrap's
    // utc_from (inclusive) → off-peak.
    expect(computeCost(oneM(), twoSlot, at(1)).totalCostUSD).toBeCloseTo(2.0, 6);
    expect(computeCost(oneM(), twoSlot, at(10)).totalCostUSD).toBeCloseTo(1.0, 6);
  });

  it("leaves flat entries unaffected — pricedAt is ignored for a flat price map", () => {
    expect(
      computeCost([mkEntry({ model: "pro-model", input_tokens: 1_000_000 })], prices, at(3))
        .totalCostUSD,
    ).toBeCloseTo(1.1, 6);
  });

  it("warns and prices $0 when the slots leave the instant uncovered (a gap)", () => {
    const warn = vi.fn();
    const gap = slotted({
      "slot-model": {
        slots: [
          {
            utc_from: "01:00",
            utc_to: "10:00",
            in: 2.0,
            out: 4.0,
            cache_read: 0.2,
            cache_write: 0.0,
          },
        ],
      },
    });
    expect(computeCost(oneM(), gap, at(23), warn).totalCostUSD).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("0 price slots"));
  });

  it("warns and prices $0 when two slots overlap the instant", () => {
    const warn = vi.fn();
    const overlap = slotted({
      "slot-model": {
        slots: [
          {
            utc_from: "00:00",
            utc_to: "12:00",
            in: 2.0,
            out: 4.0,
            cache_read: 0.2,
            cache_write: 0.0,
          },
          {
            utc_from: "06:00",
            utc_to: "18:00",
            in: 3.0,
            out: 6.0,
            cache_read: 0.3,
            cache_write: 0.0,
          },
        ],
      },
    });
    expect(computeCost(oneM(), overlap, at(8), warn).totalCostUSD).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2 price slots"));
  });

  it("warns and prices $0 for a slotted model when no run instant is supplied", () => {
    const warn = vi.fn();
    expect(computeCost(oneM(), twoSlot, undefined, warn).totalCostUSD).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no run instant"));
  });

  it("applies the SELECTED slot's out/cache_read/cache_write multipliers, not just in", () => {
    const m = slotted({
      "slot-model": {
        slots: [
          { utc_from: "00:00", utc_to: "12:00", in: 1, out: 2, cache_read: 3, cache_write: 4 },
          { utc_from: "12:00", utc_to: "00:00", in: 9, out: 9, cache_read: 9, cache_write: 9 },
        ],
      },
    });
    const report = computeCost(
      [
        {
          model: "slot-model",
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_tokens: 1_000_000,
          cache_write_tokens: 1_000_000,
        },
      ],
      m,
      at(3), // the 00:00–12:00 slot (1/2/3/4), NOT the 12:00→00:00 slot (all 9s)
    );
    // (1M·1 + 1M·2 + 1M·3 + 1M·4) / 1e6 = 1 + 2 + 3 + 4 = 10; a swapped multiplier would not sum to 10.
    expect(report.totalCostUSD).toBeCloseTo(10, 6);
  });

  it("selects correctly across the real DeepSeek 4-slot shape (peak 01–04 + 06–10 UTC)", () => {
    const ds = slotted({
      "slot-model": {
        slots: [
          { utc_from: "10:00", utc_to: "01:00", in: 1.0, out: 0, cache_read: 0, cache_write: 0 },
          { utc_from: "01:00", utc_to: "04:00", in: 2.0, out: 0, cache_read: 0, cache_write: 0 },
          { utc_from: "04:00", utc_to: "06:00", in: 1.0, out: 0, cache_read: 0, cache_write: 0 },
          { utc_from: "06:00", utc_to: "10:00", in: 2.0, out: 0, cache_read: 0, cache_write: 0 },
        ],
      },
    });
    // peak windows
    expect(computeCost(oneM(), ds, at(2)).totalCostUSD).toBeCloseTo(2.0, 6);
    expect(computeCost(oneM(), ds, at(8)).totalCostUSD).toBeCloseTo(2.0, 6);
    // off-peak: the between-peaks band (04–06), the daytime tail, and the wrap past midnight
    expect(computeCost(oneM(), ds, at(5)).totalCostUSD).toBeCloseTo(1.0, 6);
    expect(computeCost(oneM(), ds, at(12)).totalCostUSD).toBeCloseTo(1.0, 6);
    expect(computeCost(oneM(), ds, at(0, 30)).totalCostUSD).toBeCloseTo(1.0, 6);
  });

  it("a degenerate utc_from == utc_to slot covers the full day (the schema's wrap semantics)", () => {
    const allDay = slotted({
      "slot-model": {
        slots: [
          { utc_from: "00:00", utc_to: "00:00", in: 5, out: 0, cache_read: 0, cache_write: 0 },
        ],
      },
    });
    expect(computeCost(oneM(), allDay, at(3)).totalCostUSD).toBeCloseTo(5, 6);
    expect(computeCost(oneM(), allDay, at(15)).totalCostUSD).toBeCloseTo(5, 6);
  });
});

describe("parseInstant + PriceMapCodec parity (issue #170 review)", () => {
  const wrap = (m: unknown): unknown => ({ _updated: "x", _unit: "y", models: { model: m } });

  it("parseInstant returns a Date for a valid ISO instant and undefined for garbage/absent", () => {
    expect(parseInstant("2026-08-16T03:00:00.000Z")?.getUTCHours()).toBe(3);
    expect(parseInstant("not-a-date")).toBeUndefined();
    expect(parseInstant(undefined)).toBeUndefined();
    // A date-time with no UTC offset is rejected (would parse as ambiguous local time).
    expect(parseInstant("2026-08-16T03:00:00")).toBeUndefined();
  });

  it("rejects a negative rate, empty slots, and a hybrid flat+slots entry (the ajv gate rejects each)", () => {
    expect(PriceMapCodec.decode(wrap({ in: -1, out: 0, cache_read: 0, cache_write: 0 }))._tag).toBe(
      "Left",
    );
    expect(PriceMapCodec.decode(wrap({ slots: [] }))._tag).toBe("Left");
    expect(
      PriceMapCodec.decode(
        wrap({
          in: 1,
          out: 1,
          cache_read: 1,
          cache_write: 1,
          slots: [
            { utc_from: "00:00", utc_to: "12:00", in: 1, out: 1, cache_read: 1, cache_write: 1 },
          ],
        }),
      )._tag,
    ).toBe("Left");
  });

  it("still accepts a flat map and a well-formed slotted map", () => {
    expect(PriceMapCodec.decode(wrap({ in: 1, out: 2, cache_read: 3, cache_write: 4 }))._tag).toBe(
      "Right",
    );
    expect(
      PriceMapCodec.decode(
        wrap({
          slots: [
            { utc_from: "10:00", utc_to: "01:00", in: 1, out: 2, cache_read: 3, cache_write: 4 },
            { utc_from: "01:00", utc_to: "10:00", in: 5, out: 6, cache_read: 7, cache_write: 8 },
          ],
        }),
      )._tag,
    ).toBe("Right");
  });
});
