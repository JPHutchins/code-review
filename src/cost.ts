// Recomputes USD (the CLI's vendor_cost_usd is vendor-priced); warnings threaded via a `warn` sink.

import type { PriceMap, ModelUsageEntry } from "./schema.js";

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

const computeModelCost = (entry: ModelUsageEntry, prices: PriceMap, warn: Warn): CostLine => {
  const p = prices.models[entry.model];
  const cacheRead = entry.cache_read_tokens ?? 0;
  const cacheWrite = entry.cache_write_tokens ?? 0;
  if (!p) {
    warn(
      `code-review cost: unknown model "${entry.model}" — no entry in price map; cost for this model set to $0`,
    );
    return {
      model: entry.model,
      inputTokens: entry.input_tokens,
      outputTokens: entry.output_tokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUSD: 0,
    };
  }
  const costUSD =
    (entry.input_tokens * p.in +
      entry.output_tokens * p.out +
      cacheRead * p.cache_read +
      cacheWrite * p.cache_write) /
    1_000_000;
  return {
    model: entry.model,
    inputTokens: entry.input_tokens,
    outputTokens: entry.output_tokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    costUSD,
  };
};

export const computeCost = (
  models: readonly ModelUsageEntry[],
  prices: PriceMap,
  warn: Warn = defaultWarn,
): CostReport => {
  const lines = models.map((entry) => computeModelCost(entry, prices, warn));

  return {
    lines,
    totalInputTokens: lines.reduce((s, l) => s + l.inputTokens, 0),
    totalOutputTokens: lines.reduce((s, l) => s + l.outputTokens, 0),
    totalCacheReadTokens: lines.reduce((s, l) => s + l.cacheReadTokens, 0),
    totalCacheWriteTokens: lines.reduce((s, l) => s + l.cacheWriteTokens, 0),
    totalCostUSD: lines.reduce((s, l) => s + l.costUSD, 0),
  };
};
