// Findings 0.4 REQUIRES reasoning/confidence, which can't be honestly upcast from a 0.2/0.3 document
// (confidence can't be fabricated) — so older minors are dropped from the table and degrade to the
// unsupported-version notice. Imports schema.ts one-way (schema.ts stays a leaf; no import cycle).
// Bundled schema paths resolve via tsup into the same dist as index.ts, so import.meta.dirname
// matches at runtime, in dev, and from the published package.

import { resolve as resolvePath } from "node:path";
import type { Decoder, Encoder, Errors, ValidationError } from "io-ts";
import { FindingsCodec, TriageCodec, PriceMapCodec, DEFAULT_SCHEMA_VERSION } from "./schema.js";
import type { Findings, Triage, PriceMap } from "./schema.js";

export type SchemaKind = "findings" | "triage" | "prices";

export interface DecodedFor {
  readonly findings: Findings;
  readonly triage: Triage;
  readonly prices: PriceMap;
}

interface VersionEntry<K extends SchemaKind, A> {
  /** major.minor of `schema_version` this entry dispatches on; patch is ignored. */
  readonly minor: string;
  /** full semver stamped when a document omits `schema_version` (findings) or reported as the
   *  resolved version for kinds with no in-data signal (triage, prices). */
  readonly defaultVersion: string;
  readonly schemaFile: string;
  readonly codec: Decoder<unknown, A> & Encoder<A, unknown>;
  /** upcast to the latest shape for this kind; identity when the codec already accepts both
   *  shapes (e.g. an additive minor whose new field is optional). */
  readonly normalize: (decoded: A) => DecodedFor[K];
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

const findingsTable: readonly VersionEntry<"findings", Findings>[] = [
  {
    minor: "0.4",
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
    minor: "0.1",
    defaultVersion: "0.1.0",
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

/** Resolve a kind with no in-data version signal — a single bundled entry, never "missing-version". */
const resolveSingleVersion = <K extends "triage" | "prices">(
  kind: K,
  raw: unknown,
): Resolution<K> => {
  const entry = tableFor(kind)[0];
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
