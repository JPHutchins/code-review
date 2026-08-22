// Recomputes USD (the CLI's vendor_cost_usd is vendor-priced); warnings threaded via a `warn` sink.

import type {
  PriceMap,
  ModelUsageEntry,
  ModelPrices,
  FlatModelPrices,
  PriceSlot,
} from "./schema.js";

export interface CostLine {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUSD: number;
}

export interface CostReport {
  readonly lines: readonly CostLine[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheWriteTokens: number;
  readonly totalCostUSD: number;
}

export type Warn = (message: string) => void;

const defaultWarn: Warn = (message) => {
  process.stderr.write(`${message}\n`);
};

// A parseable UTC instant from an ISO string, or undefined — so an unparseable/no-offset generated_at
// (issue #170 review r2) falls back to the caller's instant rather than pricing at an Invalid Date.
export const parseInstant = (iso: string | undefined): Date | undefined => {
  if (iso === undefined) return undefined;
  // A date-TIME with no UTC designator (Z or ±offset) is parsed as LOCAL time by Date — ambiguous and
  // slot-wrong. Reject a T-bearing instant that lacks an explicit offset (adapt stamps toISOString(),
  // always Z; a date-only value is unambiguous UTC midnight and is allowed).
  if (iso.includes("T") && !/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const utcMinuteOfDay = (at: Date): number => at.getUTCHours() * 60 + at.getUTCMinutes();

const hhmmToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

const hhmmOf = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

// A [utc_from, utc_to) half-open UTC window contains `minute`; when utc_to <= utc_from the window wraps
// past midnight (e.g. 22:00→02:00 covers the late night and early morning). A degenerate utc_from ==
// utc_to therefore covers the FULL day (wrap branch), matching the schema's "utc_to <= utc_from wraps".
const slotCovers = (slot: PriceSlot, minute: number): boolean => {
  const from = hhmmToMinutes(slot.utc_from);
  const to = hhmmToMinutes(slot.utc_to);
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
};

// The flat per-token rate for a model at the run's UTC instant (issue #170): a flat entry as-is; a
// slotted entry's covering slot. A slotted map that leaves the instant uncovered (a gap) or double-
// covers it (an overlap) — or a slotted model priced with no instant supplied — is a misconfiguration:
// warn LOUDLY (like the unknown-model path) and return null so cost falls back to $0 for that model,
// never crashing and never silently mis-pricing.
// Weekend-ness is a property of the BEIJING date, not the UTC one — the provider states the rule in
// Beijing time (see the schema's weekend_slots description, which is the spec). Beijing keeps no
// daylight saving, so a fixed +8 is exact rather than an approximation (issue #216).
const BEIJING_OFFSET_MINUTES = 8 * 60;

const isBeijingWeekend = (instant: Date): boolean => {
  const day = new Date(instant.getTime() + BEIJING_OFFSET_MINUTES * 60_000).getUTCDay();
  return day === 0 || day === 6;
};

const resolveFlatPrices = (
  model: string,
  p: ModelPrices,
  pricedAt: Date | undefined,
  warn: Warn,
): FlatModelPrices | null => {
  if (!("slots" in p)) return p;
  if (pricedAt === undefined) {
    warn(
      `code-review cost: model "${model}" has time-slotted prices but no run instant was supplied to select a slot; cost for this model set to $0`,
    );
    return null;
  }
  const minute = utcMinuteOfDay(pricedAt);
  const weekendSlots = p.weekend_slots;
  const useWeekend = weekendSlots != null && isBeijingWeekend(pricedAt);
  const slots = useWeekend ? weekendSlots : p.slots;
  const covering = slots.filter((s) => slotCovers(s, minute));
  if (covering.length === 1) return covering[0] ?? null;
  warn(
    `code-review cost: model "${model}" — ${String(covering.length)} price slots in \`${useWeekend ? "weekend_slots" : "slots"}\` cover ${hhmmOf(minute)} UTC (expected exactly 1); that array must partition the 24h day with no gap or overlap; cost for this model set to $0`,
  );
  return null;
};

const computeModelCost = (
  entry: ModelUsageEntry,
  prices: PriceMap,
  pricedAt: Date | undefined,
  warn: Warn,
): CostLine => {
  const p = prices.models[entry.model];
  const cacheRead = entry.cache_read_tokens ?? 0;
  const cacheWrite = entry.cache_write_tokens ?? 0;
  const zero: CostLine = {
    model: entry.model,
    inputTokens: entry.input_tokens,
    outputTokens: entry.output_tokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    costUSD: 0,
  };
  if (!p) {
    warn(
      `code-review cost: unknown model "${entry.model}" — no entry in price map; cost for this model set to $0`,
    );
    return zero;
  }
  const rate = resolveFlatPrices(entry.model, p, pricedAt, warn);
  if (rate === null) return zero;
  const costUSD =
    (entry.input_tokens * rate.in +
      entry.output_tokens * rate.out +
      cacheRead * rate.cache_read +
      cacheWrite * rate.cache_write) /
    1_000_000;
  return { ...zero, costUSD };
};

export const computeCost = (
  models: readonly ModelUsageEntry[],
  prices: PriceMap,
  // The run's UTC instant, used to select a time-slotted model's rate (issue #170). Undefined is fine
  // for a flat price map (ignored); a slotted model priced without it degrades to $0 with a warning.
  pricedAt?: Date,
  warn: Warn = defaultWarn,
): CostReport => {
  const lines = models.map((entry) => computeModelCost(entry, prices, pricedAt, warn));

  return {
    lines,
    totalInputTokens: lines.reduce((s, l) => s + l.inputTokens, 0),
    totalOutputTokens: lines.reduce((s, l) => s + l.outputTokens, 0),
    totalCacheReadTokens: lines.reduce((s, l) => s + l.cacheReadTokens, 0),
    totalCacheWriteTokens: lines.reduce((s, l) => s + l.cacheWriteTokens, 0),
    totalCostUSD: lines.reduce((s, l) => s + l.costUSD, 0),
  };
};
