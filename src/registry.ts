// Findings 0.4 REQUIRES reasoning/confidence, which can't be honestly upcast from a 0.2/0.3 document
// (confidence can't be fabricated) — so older minors are dropped from the table and degrade to the
// unsupported-version notice. Imports schema.ts one-way (schema.ts stays a leaf; no import cycle).
// Bundled schema paths resolve via tsup into the same dist as index.ts, so import.meta.dirname
// matches at runtime, in dev, and from the published package.

import { resolve as resolvePath } from "node:path";
import type * as t from "io-ts";
import type { Decoder, Encoder, Errors, ValidationError } from "io-ts";
import {
  FindingsCodec,
  FindingsCodecV09,
  normalizeV09,
  TriageCodec,
  PriceMapCodec,
  DEFAULT_SCHEMA_VERSION,
} from "./schema.js";
import type { Findings, Triage, PriceMap } from "./schema.js";

export type SchemaKind = "findings" | "triage" | "prices";

export interface DecodedFor {
  readonly findings: Findings;
  readonly triage: Triage;
  readonly prices: PriceMap;
}

interface VersionEntry<K extends SchemaKind, A, D = A> {
  /** major.minor of `schema_version` this entry dispatches on; patch is ignored. */
  readonly minor: string;
  /** full semver stamped when a document omits `schema_version` (findings) or reported as the
   *  resolved version for kinds with no in-data signal (triage, prices). */
  readonly defaultVersion: string;
  readonly schemaFile: string;
  readonly codec: Decoder<unknown, D> & Encoder<D, unknown>;
  /** upcast to the latest shape for this kind; identity when the codec already accepts both
   *  shapes (e.g. an additive minor whose new field is optional). */
  readonly normalize: (decoded: D) => DecodedFor[K];
  readonly latest: boolean;
}

export type Resolution<K extends SchemaKind> =
  | { readonly kind: "ok"; readonly version: string; readonly value: DecodedFor[K] }
  | {
      readonly kind: "unsupported-version";
      readonly version: string;
      readonly supported: readonly string[];
    }
  | { readonly kind: "invalid-shape"; readonly errors: readonly string[] }
  | { readonly kind: "missing-version" }; // findings only; triage/prices never return this

const identity = <A>(decoded: A): A => decoded;

// 0.5 widened the verdict enum with the pipeline-only "error" value, 0.6 added the optional
// systemic_problems array, and 0.9 added REQUIRED `likelihood` (the draft axis skips 0.7/0.8, which
// belong to the surface-signal axis — issue #156 — so the two version spaces stay distinct). 0.10
// made `id` REQUIRED (code → id), so every pre-0.10 minor now decodes through the one tolerant legacy
// codec and upcasts to the 0.10 shape (code → id, or the synthesized content-derived id when a
// finding carried none) — a pre-0.10 doc without an id still resolves, and the dropped 0.2/0.3 minors
// still can't (they lack the required reasoning/confidence). Keeping the older minors live matches
// their declared version to a supported entry rather than reporting an unknown version.
const legacyFindingsCodec = FindingsCodecV09 as unknown as Decoder<unknown, Findings> &
  Encoder<Findings, unknown>;
const legacyFindingsNormalize = (doc: t.TypeOf<typeof FindingsCodecV09>): Findings =>
  normalizeV09(doc);

const findingsTable: readonly VersionEntry<"findings", Findings>[] = [
  {
    minor: "0.4",
    defaultVersion: "0.4.0",
    // The frozen tolerant-in legacy schema, NOT the live 0.10 file: every ajv-gated channel
    // (validate --schema-version, the extraction ladder) dispatches the RAW doc's declared minor
    // through schemaPathFor, so the ajv gate must accept exactly what the tolerant legacy codec
    // accepts — the live file (id required) would reject the legacy docs the upcast promises to read.
    schemaFile: "v0.9/findings.schema.json",
    codec: legacyFindingsCodec,
    normalize: legacyFindingsNormalize,
    latest: false,
  },
  {
    minor: "0.5",
    defaultVersion: "0.5.0",
    schemaFile: "v0.9/findings.schema.json",
    codec: legacyFindingsCodec,
    normalize: legacyFindingsNormalize,
    latest: false,
  },
  {
    minor: "0.6",
    defaultVersion: "0.6.0",
    schemaFile: "v0.9/findings.schema.json",
    codec: legacyFindingsCodec,
    normalize: legacyFindingsNormalize,
    latest: false,
  },
  {
    minor: "0.9",
    defaultVersion: "0.9.0",
    schemaFile: "v0.9/findings.schema.json",
    codec: legacyFindingsCodec,
    normalize: legacyFindingsNormalize,
    latest: false,
  },
  {
    minor: "0.10",
    defaultVersion: DEFAULT_SCHEMA_VERSION,
    schemaFile: "findings.schema.json",
    codec: FindingsCodec,
    normalize: identity,
    latest: true,
  },
];

const triageTable: readonly VersionEntry<"triage", Triage>[] = [
  {
    minor: "0.1",
    defaultVersion: "0.1.0",
    schemaFile: "triage.schema.json",
    codec: TriageCodec,
    normalize: identity,
    latest: true,
  },
];

const pricesTable: readonly VersionEntry<"prices", PriceMap>[] = [
  {
    // Retained non-latest so `validate`/`print-schema --schema-version 0.1` still resolves (the
    // keep-old-minors convention the findings table follows). The price map carries no version signal,
    // and the schema is a single unversioned file, so both entries point at it; the codec's oneOf
    // accepts a flat 0.1-era map unchanged.
    minor: "0.1",
    defaultVersion: "0.1.0",
    schemaFile: "prices.schema.json",
    codec: PriceMapCodec,
    normalize: identity,
    latest: false,
  },
  {
    // v0.2.0 (issue #170): a model's value gained the time-slotted alternative (flat | { slots }).
    minor: "0.2",
    defaultVersion: "0.2.0",
    schemaFile: "prices.schema.json",
    codec: PriceMapCodec,
    normalize: identity,
    latest: true,
  },
];

type Table<K extends SchemaKind> = readonly VersionEntry<K, DecodedFor[K]>[];

const tables: { readonly [K in SchemaKind]: Table<K> } = {
  findings: findingsTable,
  triage: triageTable,
  prices: pricesTable,
};

const tableFor = <K extends SchemaKind>(kind: K): Table<K> => tables[kind];

/** major.minor of a semver-ish string; dispatch ignores patch and any prerelease/build suffix. */
const majorMinor = (version: string): string => version.split(".").slice(0, 2).join(".");

const describeValidationError = (e: ValidationError): string => {
  const path = e.context
    .map((entry) => entry.key)
    .filter((key) => key.length > 0)
    .join(".");
  return e.message ?? `${path || "(root)"}: invalid value ${JSON.stringify(e.value)}`;
};

const formatErrors = (errors: Errors): readonly string[] => errors.map(describeValidationError);

export const declaredVersion = (raw: unknown): string | undefined =>
  typeof raw === "object" && raw !== null && "schema_version" in raw
    ? typeof raw.schema_version === "string"
      ? raw.schema_version
      : undefined
    : undefined;

export const supportedVersions = (kind: SchemaKind): readonly string[] =>
  tableFor(kind).map((entry) => entry.minor);

export const defaultVersion = (kind: SchemaKind): string => {
  const latest = tableFor(kind).find((entry) => entry.latest);
  if (!latest) throw new Error(`Registry invariant violated — no latest entry for "${kind}"`);
  return latest.defaultVersion;
};

const bundledSchemaPath = (relativePath: string): string =>
  resolvePath(import.meta.dirname, "..", "schema", relativePath);

export const schemaPathFor = (kind: SchemaKind, version?: string): string => {
  const table = tableFor(kind);
  const entry =
    version === undefined
      ? table.find((v) => v.latest)
      : table.find((v) => v.minor === majorMinor(version));
  if (!entry) {
    throw new Error(
      `Unsupported ${kind} schema version "${version ?? ""}" — supported: ${supportedVersions(kind).join(", ")}`,
    );
  }
  return bundledSchemaPath(entry.schemaFile);
};

const resolveFindings = (raw: unknown): Resolution<"findings"> => {
  const version = declaredVersion(raw);
  if (version === undefined) return { kind: "missing-version" };
  const entry = findingsTable.find((v) => v.minor === majorMinor(version));
  if (!entry) {
    return { kind: "unsupported-version", version, supported: supportedVersions("findings") };
  }
  const decoded = entry.codec.decode(raw);
  return decoded._tag === "Left"
    ? { kind: "invalid-shape", errors: formatErrors(decoded.left) }
    : { kind: "ok", version, value: entry.normalize(decoded.right) };
};

/** Resolve a kind with no in-data version signal, never "missing-version". A versionless document is
 * the CURRENT contract, so it resolves against the latest entry (matching defaultVersion/schemaPathFor);
 * older entries exist only so an explicit `--schema-version` still resolves. */
const resolveSingleVersion = <K extends "triage" | "prices">(
  kind: K,
  raw: unknown,
): Resolution<K> => {
  const table = tableFor(kind);
  const entry = table.find((e) => e.latest) ?? table[0];
  if (!entry) throw new Error(`Registry invariant violated — no entry for "${kind}"`);
  const decoded = entry.codec.decode(raw);
  return decoded._tag === "Left"
    ? { kind: "invalid-shape", errors: formatErrors(decoded.left) }
    : { kind: "ok", version: entry.defaultVersion, value: entry.normalize(decoded.right) };
};

const resolvers: { readonly [K in SchemaKind]: (raw: unknown) => Resolution<K> } = {
  findings: resolveFindings,
  triage: (raw) => resolveSingleVersion("triage", raw),
  prices: (raw) => resolveSingleVersion("prices", raw),
};

/** Decode + version-dispatch a raw document for a schema kind. Pure — no IO. */
export const resolve = <K extends SchemaKind>(kind: K, raw: unknown): Resolution<K> =>
  resolvers[kind](raw);

// The seed chain's tolerant findings resolution: the value when the document resolves, and — when the
// STRICT entry rejects a body the migration's tolerant-in contract admits (a peeled legacy surfaced
// blob re-stamped with the CURRENT draft version, or a hybrid doc whose findings carry the pre-0.10
// `code` spelling) — the legacy codec's upcast value. null for an unsupported-version stamp: the
// fallback must never revive a version the allowlist refuses (a dropped 0.2/0.3 minor, a future
// 0.11+/1.x) and re-stamp it 0.10.0. The ONE place this upcast policy lives, shared by every raw-
// document channel (the seed gate; the marker readers apply the same precedence on their fragments).
export const resolveTolerantFindings = (doc: unknown): Findings | null => {
  const r = resolveFindings(doc);
  if (r.kind === "ok") return r.value;
  if (r.kind === "unsupported-version") return null;
  const legacy = FindingsCodecV09.decode(doc);
  return legacy._tag === "Right" ? normalizeV09(legacy.right) : null;
};
