// The transcript is the only surviving spend record when a wall-clock kill leaves no clean result
// envelope, and the live in-flight signal the budget hook steers on. Reading is total: a truncated
// final line (a `timeout` kill mid-flush) or any malformed entry is skipped, never thrown.

import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ModelUsageEntry } from "./schema.js";
import { asRecord, readFileOrNull } from "./util.js";

export interface TranscriptUsage {
  readonly models: readonly ModelUsageEntry[];
  readonly turns: number;
  readonly durationMs: number;
  readonly firstTsMs: number | null;
  readonly lastTsMs: number | null;
}

// `missing` distinguishes an unreadable main transcript (no signal at all) from an empty-but-present one.
export interface TranscriptTree {
  readonly entries: readonly unknown[];
  readonly files: readonly string[];
  readonly missing: boolean;
}

// Non-negative finite, else 0 — a NaN/absent field must not poison the sum.
const numField = (rec: Record<string, unknown>, key: string): number => {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
};

interface MessageUsage {
  readonly id: string | null;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

// Claude Code names cache fields cache_read_input_tokens/cache_creation_input_tokens; the abstract
// envelope names them cache_read_tokens/cache_write_tokens — the rename happens here. `id` is carried
// so a message logged across several lines (one per content block of a parallel tool-use turn, each
// repeating the message-level usage) is summed once.
const messageUsage = (entry: unknown): MessageUsage | null => {
  const rec = asRecord(entry);
  if (rec === null || rec["type"] !== "assistant") return null;
  const msg = asRecord(rec["message"]);
  if (msg === null) return null;
  const model = msg["model"];
  const usage = asRecord(msg["usage"]);
  if (typeof model !== "string" || usage === null) return null;
  const id = msg["id"];
  return {
    id: typeof id === "string" ? id : null,
    model,
    input: numField(usage, "input_tokens"),
    output: numField(usage, "output_tokens"),
    cacheRead: numField(usage, "cache_read_input_tokens"),
    cacheWrite: numField(usage, "cache_creation_input_tokens"),
  };
};

const tsMsOf = (entry: unknown): number | null => {
  const rec = asRecord(entry);
  const ts = rec?.["timestamp"];
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
};

interface Totals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}
const EMPTY_TOTALS: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// One object per non-blank line, dropping any that fails to parse — this makes a timeout-truncated
// final line a no-op rather than a crash.
export const parseJsonl = (text: string): readonly unknown[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });

// A message logged over multiple lines (repeated message.id) is counted once — otherwise a parallel
// tool-use turn's usage, stamped on every content-block line, is summed several times and inflates
// spend. Entries with no id are counted as-is. `models` order follows first-appearance.
export const sumTranscriptUsage = (entries: readonly unknown[]): TranscriptUsage => {
  const summed = entries.reduce<{ totals: Map<string, Totals>; turns: number; seen: Set<string> }>(
    (acc, entry) => {
      const u = messageUsage(entry);
      if (u === null) return acc;
      if (u.id !== null && acc.seen.has(u.id)) return acc;
      if (u.id !== null) acc.seen.add(u.id);
      const prev = acc.totals.get(u.model) ?? EMPTY_TOTALS;
      acc.totals.set(u.model, {
        input: prev.input + u.input,
        output: prev.output + u.output,
        cacheRead: prev.cacheRead + u.cacheRead,
        cacheWrite: prev.cacheWrite + u.cacheWrite,
      });
      return { totals: acc.totals, turns: acc.turns + 1, seen: acc.seen };
    },
    { totals: new Map(), turns: 0, seen: new Set() },
  );

  const models: readonly ModelUsageEntry[] = [...summed.totals].map(([model, t]) => ({
    model,
    input_tokens: t.input,
    output_tokens: t.output,
    cache_read_tokens: t.cacheRead,
    cache_write_tokens: t.cacheWrite,
  }));

  const bounds = entries.reduce<{ min: number | null; max: number | null }>(
    (acc, entry) => {
      const ms = tsMsOf(entry);
      if (ms === null) return acc;
      return {
        min: acc.min === null || ms < acc.min ? ms : acc.min,
        max: acc.max === null || ms > acc.max ? ms : acc.max,
      };
    },
    { min: null, max: null },
  );

  return {
    models,
    turns: summed.turns,
    durationMs: bounds.min !== null && bounds.max !== null ? bounds.max - bounds.min : 0,
    firstTsMs: bounds.min,
    lastTsMs: bounds.max,
  };
};

// Claude Code writes each subagent to <dir>/<session-id>/subagents/agent-*.jsonl, beside
// <dir>/<session-id>.jsonl. An empty result covers a missing directory or an older/other layout.
const subagentFiles = (mainPath: string): readonly string[] => {
  const dir = join(dirname(mainPath), basename(mainPath, ".jsonl"), "subagents");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
};

// Two layouts: subagents in their own files, OR inlined into the main marked isSidechain:true. Read
// the sibling files ONLY when the main carries no inline sidechain, so either layout is summed once.
export const readTranscriptTree = (mainPath: string): TranscriptTree => {
  const mainText = readFileOrNull(mainPath);
  const mainEntries = mainText === null ? [] : parseJsonl(mainText);
  const inlineSidechains = mainEntries.some((e) => asRecord(e)?.["isSidechain"] === true);
  const siblings = inlineSidechains ? [] : subagentFiles(mainPath);
  const siblingReads = siblings.flatMap((path) => {
    const text = readFileOrNull(path);
    return text === null ? [] : [{ path, entries: parseJsonl(text) }];
  });
  return {
    entries: [...mainEntries, ...siblingReads.flatMap((r) => r.entries)],
    files: [...(mainText === null ? [] : [mainPath]), ...siblingReads.map((r) => r.path)],
    missing: mainText === null,
  };
};
