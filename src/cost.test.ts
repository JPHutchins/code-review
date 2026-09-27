import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { computeCost, costAxisAnnouncement, parseInstant, warnStalePrices } from "./cost.js";
import { RELEASED } from "./released.js";
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
    // costUSD stays a plain number (0) — the provenance signal travels beside it, never as a
    // sentinel, so the render layer keeps owning the N/A presentation decision (issue #221).
    expect(report.lines[0]!.known).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown-model"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("price map"));
  });

  it("marks a priced model known:true", () => {
    const report = computeCost(
      [mkEntry({ model: "pro-model", input_tokens: 100, output_tokens: 10 })],
      prices,
      undefined,
      vi.fn(),
    );
    expect(report.lines[0]!.known).toBe(true);
  });

  it("marks an unpriceable slotted row known:false too — no run instant selects no slot", () => {
    const warn = vi.fn();
    const report = computeCost(
      [mkEntry({ model: "slot-model" })],
      {
        _updated: "2026-08-16",
        _unit: "u",
        models: {
          "slot-model": {
            slots: [
              { utc_from: "00:00", utc_to: "00:00", in: 1, out: 1, cache_read: 0, cache_write: 0 },
            ],
          },
        },
      },
      undefined,
      warn,
    );
    expect(report.lines[0]!.known).toBe(false);
    expect(report.lines[0]!.costUSD).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("does not treat a prototype-chain model name as priced", () => {
    const warn = vi.fn();
    const report = computeCost([mkEntry({ model: "constructor" })], prices, undefined, warn);
    expect(report.lines[0]!.known).toBe(false);
    expect(report.lines[0]!.costUSD).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown model"));
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

  it("escapes a line-broken model id in the slot-misconfiguration warns (annotationSafe house shape)", () => {
    const warn = vi.fn();
    computeCost(
      [mkEntry({ model: "evil\n::error::forged" })],
      {
        _updated: "2026-08-16",
        _unit: "u",
        models: {
          "evil\n::error::forged": {
            // A real instant OUTSIDE this window reaches the coverage-count warn (the branch the
            // escape must be proven on), not the no-instant warn.
            slots: [
              { utc_from: "01:00", utc_to: "02:00", in: 1, out: 1, cache_read: 0, cache_write: 0 },
            ],
          },
        },
      },
      new Date("2026-09-27T05:00:00Z"),
      warn,
    );
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    expect(message).not.toContain("\n");
    expect(message).toContain("::error::forged");
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
  // The stamp shape is NOT a decode concern (the codec types _updated as any string; the staleness
  // axis validates it at the consumer and degrades instead of aborting) — a valid stamp here keeps
  // the fixtures realistic.
  const wrap = (m: unknown): unknown => ({
    _updated: "2026-08-16",
    _unit: "y",
    models: { model: m },
  });

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

  // Same rejections on the weekend axis: the ajv gate refuses each of these, and the two gates must
  // agree or a map passes one surface and fails the other.
  it("rejects an empty, null, or flat-hybrid weekend_slots exactly as it does for slots", () => {
    const oneSlot = [
      { utc_from: "00:00", utc_to: "00:00", in: 1, out: 1, cache_read: 1, cache_write: 1 },
    ];
    expect(PriceMapCodec.decode(wrap({ slots: oneSlot, weekend_slots: [] }))._tag).toBe("Left");
    expect(PriceMapCodec.decode(wrap({ slots: oneSlot, weekend_slots: null }))._tag).toBe("Left");
    expect(
      PriceMapCodec.decode(
        wrap({ in: 1, out: 1, cache_read: 1, cache_write: 1, weekend_slots: oneSlot }),
      )._tag,
    ).toBe("Left");
    expect(PriceMapCodec.decode(wrap({ slots: oneSlot, weekend_slots: oneSlot }))._tag).toBe(
      "Right",
    );
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

// DeepSeek bills off-peak all day on Saturdays and Sundays, BEIJING time, from 2026-08-23 (#216). The
// rule is stated in Beijing time, so weekend-ness is not a property of the UTC date: the Beijing
// weekend runs Friday 16:00 UTC to Sunday 16:00 UTC.
describe("weekend_slots — the Beijing weekend overrides the weekday map (issue #216)", () => {
  const prices = {
    _updated: "2026-08-22",
    _unit: "USD per 1M tokens",
    models: {
      m: {
        slots: [
          { utc_from: "00:00", utc_to: "01:00", in: 1, out: 1, cache_read: 1, cache_write: 0 },
          { utc_from: "01:00", utc_to: "04:00", in: 2, out: 2, cache_read: 2, cache_write: 0 },
          { utc_from: "04:00", utc_to: "00:00", in: 1, out: 1, cache_read: 1, cache_write: 0 },
        ],
        // A rate distinct from BOTH weekday rates, so an assertion can tell which MAP was chosen and
        // not merely which rate happened to match. With the weekend rate equal to the weekday
        // off-peak rate, every boundary assertion passes under a plain UTC-date check too — which is
        // exactly the blind spot these tests exist to pin.
        weekend_slots: [
          { utc_from: "00:00", utc_to: "00:00", in: 3, out: 3, cache_read: 3, cache_write: 0 },
        ],
      },
    },
  };
  const usage = [{ model: "m", input_tokens: 1_000_000, output_tokens: 0 }];
  const at = (iso: string) => computeCost(usage, prices, new Date(iso)).lines[0]!.costUSD;

  it("bills a weekday peak instant at the peak rate", () => {
    // 2026-08-24 is a Monday; 02:00 UTC = Beijing Monday 10:00.
    expect(at("2026-08-24T02:00:00Z")).toBeCloseTo(2);
  });

  it("bills the SAME clock time off the weekend map on a Beijing weekend day", () => {
    // 2026-08-23 is a Sunday; 02:00 UTC = Beijing Sunday 10:00 — the window #216 was filed for.
    expect(at("2026-08-23T02:00:00Z")).toBeCloseTo(3);
  });

  // The four instants that separate a Beijing-date check from a UTC-date one. Each pair straddles
  // 16:00 UTC, where the Beijing date has already rolled over: a UTC-date implementation gets both
  // 16:30 cases wrong, in OPPOSITE directions.
  it("treats Friday 16:00 UTC onward as the weekend, because Beijing is already Saturday", () => {
    // 2026-08-21 is a Friday. 16:30 UTC = Beijing Saturday 00:30 → weekend map.
    expect(at("2026-08-21T16:30:00Z")).toBeCloseTo(3);
    // 15:30 UTC the same day is still Beijing Friday → weekday map, off-peak slot.
    expect(at("2026-08-21T15:30:00Z")).toBeCloseTo(1);
  });

  it("treats Sunday 16:00 UTC onward as a weekday again, because Beijing is already Monday", () => {
    // 2026-08-23 is a Sunday. 15:30 UTC = Beijing Sunday 23:30 → still the weekend map.
    expect(at("2026-08-23T15:30:00Z")).toBeCloseTo(3);
    // 16:30 UTC = Beijing Monday 00:30 → weekday map, off-peak slot.
    expect(at("2026-08-23T16:30:00Z")).toBeCloseTo(1);
    // And Monday 02:00 UTC (Beijing Monday 10:00) is peak — the weekend map is not sticky.
    expect(at("2026-08-24T02:00:00Z")).toBeCloseTo(2);
  });

  // The weekday partition is checked on every weekday run; a broken weekend one is silent until a
  // weekend run reaches it, so the fail-loud invariant needs its own coverage on this branch.
  it("warns and prices $0 when weekend_slots leave the weekend instant uncovered", () => {
    const warn = vi.fn();
    const gapped = {
      ...prices,
      models: {
        m: {
          slots: prices.models.m.slots,
          weekend_slots: [
            { utc_from: "00:00", utc_to: "01:00", in: 3, out: 3, cache_read: 3, cache_write: 0 },
          ],
        },
      },
    };
    // Beijing Sunday 10:00 — inside the weekend map, outside its single row. The weekday map covers
    // this instant, so a fallback-on-gap bug would price it at 2 rather than fail loudly.
    expect(computeCost(usage, gapped, new Date("2026-08-23T02:00:00Z"), warn).totalCostUSD).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("0 price slots in `weekend_slots`"));
  });

  it("names weekend_slots, not slots, in the warning it raises about them", () => {
    const warn = vi.fn();
    const overlapping = {
      ...prices,
      models: {
        m: {
          slots: prices.models.m.slots,
          weekend_slots: [
            { utc_from: "00:00", utc_to: "00:00", in: 3, out: 3, cache_read: 3, cache_write: 0 },
            { utc_from: "00:00", utc_to: "00:00", in: 9, out: 9, cache_read: 9, cache_write: 0 },
          ],
        },
      },
    };
    computeCost(usage, overlapping, new Date("2026-08-23T02:00:00Z"), warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2 price slots in `weekend_slots`"));
  });

  it("still warns and prices $0 for a weekend-capable model when no instant is supplied", () => {
    const warn = vi.fn();
    expect(computeCost(usage, prices, undefined, warn).totalCostUSD).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no run instant was supplied"));
  });

  it("falls back to the weekday map when a model declares no weekend override", () => {
    const noWeekend = {
      ...prices,
      models: { m: { slots: prices.models.m.slots } },
    };
    const line = computeCost(usage, noWeekend, new Date("2026-08-23T02:00:00Z")).lines[0]!;
    // Beijing Sunday, but the map has no weekend rows, so the peak weekday slot still applies.
    expect(line.costUSD).toBeCloseTo(2);
  });
});

// The two gates must agree on the map this repo actually ships, not only on fixtures: ajv validates it
// in CI, and this is the codec half. A map that decodes Left makes `post` throw and takes the round
// down, so the failure belongs here rather than in a review job.
describe("the repo's own price map", () => {
  it("decodes, and every slotted model partitions both of its days", () => {
    const map = JSON.parse(readFileSync(".github/prices.json", "utf-8")) as unknown;
    const decoded = PriceMapCodec.decode(map);
    expect(decoded._tag).toBe("Right");
    if (decoded._tag !== "Right") return;

    const everyHalfHour = Array.from(
      { length: 48 },
      (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 30 * 60_000),
    );
    for (const [model, prices] of Object.entries(decoded.right.models)) {
      if (!("slots" in prices)) continue;
      for (const instant of everyHalfHour) {
        const warn = vi.fn();
        // Sunday 2026-01-04 reaches weekend_slots; the same clock time on Monday reaches slots.
        for (const day of [instant, new Date(instant.getTime() + 3 * 86_400_000)]) {
          computeCost([{ model, input_tokens: 1, output_tokens: 0 }], decoded.right, day, warn);
        }
        expect(warn).not.toHaveBeenCalled();
      }
    }
  });
});

describe("the [1m] suffix canonicalization in the pricing funnel (issue #209)", () => {
  const suffixMap: PriceMap = {
    _updated: RELEASED,
    _unit: "u",
    models: { "deepseek-v4-pro": { in: 1, out: 2, cache_read: 0.1, cache_write: 0.2 } },
  };

  it("prices a suffix-keyed envelope id against the canonical map key", () => {
    const report = computeCost(
      [{ model: "deepseek-v4-pro[1m]", input_tokens: 1_000_000, output_tokens: 0 }],
      suffixMap,
      undefined,
      vi.fn(),
    );
    expect(report.lines[0]!.known).toBe(true);
    expect(report.totalCostUSD).toBeCloseTo(1.0, 6);
  });

  it("prices a canonical envelope id against a suffix-keyed map key", () => {
    const map: PriceMap = {
      _updated: RELEASED,
      _unit: "u",
      models: { "deepseek-v4-pro[1m]": { in: 1, out: 2, cache_read: 0.1, cache_write: 0.2 } },
    };
    const report = computeCost(
      [{ model: "deepseek-v4-pro", input_tokens: 1_000_000, output_tokens: 0 }],
      map,
      undefined,
      vi.fn(),
    );
    expect(report.lines[0]!.known).toBe(true);
    expect(report.totalCostUSD).toBeCloseTo(1.0, 6);
  });

  it("warns when two map keys canonicalize to one model instead of silently merging", () => {
    const map: PriceMap = {
      _updated: RELEASED,
      _unit: "u",
      models: {
        "deepseek-v4-pro": { in: 1, out: 2, cache_read: 0.1, cache_write: 0.2 },
        "deepseek-v4-pro[1m]": { in: 3, out: 4, cache_read: 0.1, cache_write: 0.2 },
      },
    };
    const warn = vi.fn();
    computeCost(
      [{ model: "deepseek-v4-pro", input_tokens: 1, output_tokens: 0 }],
      map,
      undefined,
      warn,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("canonicalize"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deepseek-v4-pro"));
  });
});

describe("warnStalePrices (issue #220)", () => {
  const map = (updated: string): PriceMap => ({ _updated: updated, _unit: "u", models: {} });

  it("warns with a step-annotation prefix when the map predates the CLI's release", () => {
    const warn = vi.fn();
    warnStalePrices(map("2020-01-01"), warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("::warning::"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("2020-01-01"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(RELEASED));
  });

  it("stays silent for a map verified on the release date", () => {
    const warn = vi.fn();
    warnStalePrices(map(RELEASED), warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the stamp is in the future — a typo'd year silences the check permanently", () => {
    const warn = vi.fn();
    warnStalePrices(map("2999-01-01"), warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("in the future"));
  });

  it("stays silent for a null map (no consumer map provided) and degrades silently on a nonconforming stamp", () => {
    const warn = vi.fn();
    warnStalePrices(null, warn);
    // Hand-edited, non-ISO, calendar-impossible (V8 rolls 2026-02-31 into March), empty — none of
    // these can be compared, so the axis degrades instead of aborting the round (issue #220 review
    // r2).
    for (const bad of [
      "2026-8-22",
      "08/22/2026",
      "x",
      "2026-02-31",
      "",
      "2020-01-01\n::error::forged",
    ]) {
      warnStalePrices(map(bad), warn);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("the allKnown rollup is false for any unpriced line and true for an empty report ($0 engaged)", () => {
    expect(computeCost([], prices, undefined, vi.fn()).allKnown).toBe(true);
    expect(
      computeCost([mkEntry({ model: "unknown-model" })], prices, undefined, vi.fn()).allKnown,
    ).toBe(false);
    expect(
      computeCost([mkEntry({ model: "pro-model" })], prices, undefined, vi.fn()).allKnown,
    ).toBe(true);
  });

  it("costAxisAnnouncement: announce once, clear on recovery, silent otherwise", () => {
    const disengaged = computeCost(
      [mkEntry({ model: "unknown-model" })],
      prices,
      undefined,
      vi.fn(),
    );
    const engaged = computeCost([mkEntry({ model: "pro-model" })], prices, undefined, vi.fn());
    const empty = computeCost([], prices, undefined, vi.fn());
    expect(costAxisAnnouncement(disengaged, false)).toBe("announce");
    expect(costAxisAnnouncement(disengaged, true)).toBe("none");
    expect(costAxisAnnouncement(engaged, true)).toBe("clear");
    expect(costAxisAnnouncement(engaged, false)).toBe("none");
    // An empty report is engaged ($0), never an announce, and clears a stale marker.
    expect(costAxisAnnouncement(empty, false)).toBe("none");
    expect(costAxisAnnouncement(empty, true)).toBe("clear");
    expect(costAxisAnnouncement(null, true)).toBe("none");
  });

  it("collapses line breaks in a hostile model id so it cannot break out of the warning", () => {
    // The model id is the REACHABLE escape surface (a stamp with a line break degrades before the
    // warn) — the interpolation is wrapped like every other untrusted ::warning:: site.
    const warn = vi.fn();
    computeCost([mkEntry({ model: "evil\n::error::forged" })], prices, undefined, warn);
    const call = warn.mock.calls[0];
    expect(call).toBeDefined();
    const message = String(call![0]);
    expect(message).not.toContain("\n");
    expect(message).toContain("::error::forged");
  });
});
