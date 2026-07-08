// Recover per-model token usage from a Claude Code transcript (JSONL, one message object per line).
// The transcript is the only surviving record of spend when a wall-clock kill leaves no clean result
// envelope (issue #36), and the live in-flight signal the budget hook steers on (issue #38). Reading
// is total: a truncated final line (the artifact of a `timeout` kill mid-flush) or any malformed
// entry is skipped, never thrown — a cost estimate from most of the transcript beats a crash.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelUsageEntry } from "./schema.js";

/** Per-model token totals plus the coarse telemetry (turn count, wall span) the transcript carries.
 *  `models` feeds `computeCost` directly; `firstTsMs`/`lastTsMs` are epoch-ms bounds (null when no
 *  parseable timestamp is present) from which elapsed and duration are derived. */
export interface TranscriptUsage {
  readonly models: readonly ModelUsageEntry[];
  readonly turns: number;
  readonly durationMs: number;
  readonly firstTsMs: number | null;
  readonly lastTsMs: number | null;
}

/** What was actually read off disk for a transcript tree — `missing` distinguishes an unreadable
 *  main transcript (no signal at all) from an empty-but-present one. */
export interface TranscriptTree {
  readonly entries: readonly unknown[];
  readonly files: readonly string[];
  readonly missing: boolean;
}

const asRecord = (u: unknown): Record<string, unknown> | null =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : null;

/** A non-negative finite number field, or 0 — token counts are never negative and a NaN/absent
 *  field must not poison the sum. */
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

/** The usage an assistant turn contributes, or null for any other line. Claude Code names cache
 *  fields `cache_read_input_tokens`/`cache_creation_input_tokens`; the abstract envelope names them
 *  `cache_read_tokens`/`cache_write_tokens` (SPEC §6.1) — this is where that rename happens. `id` is
 *  the API message id, carried so a message logged across several lines (one per content block of a
 *  parallel tool-use turn, each repeating the message-level usage) is summed once, not per line. */
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

/** Parse JSONL loosely: one object per non-blank line, silently dropping any line that fails to
 *  parse. This is what makes a `timeout`-truncated final line a no-op rather than a crash (#39/#36). */
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

/** Sum per-model usage and derive turn count + wall span across a set of already-parsed transcript
 *  entries. A message logged over multiple lines (identified by a repeated `message.id`) is counted
 *  once — otherwise a parallel tool-use turn's usage, stamped on every one of its content-block lines,
 *  is summed several times and inflates spend (issue #38). Entries with no id can't be de-duplicated
 *  and are counted as-is. Order of `models` follows first-appearance of each model. Pure. */
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

const readFileOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
};

const subagentFiles = (mainPath: string): readonly string[] => {
  try {
    return readdirSync(join(dirname(mainPath), "subagents"))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dirname(mainPath), "subagents", name));
  } catch {
    return [];
  }
};

/** Read a transcript tree from `mainPath`. Modern Claude Code inlines subagent turns into the main
 *  transcript (marked `isSidechain: true`); an older layout wrote them to sibling `subagents/*.jsonl`
 *  instead. Sibling files are read ONLY when the main transcript carries no inline sidechain turn, so
 *  a run in either layout is summed exactly once — never doubled. (Confirming the live layout under
 *  real subagents is a dogfood item — issue #38.) Never throws: every unreadable file drops out. */
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
