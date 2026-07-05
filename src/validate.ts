// Schema validation wrapper. Validates findings JSON against the published schema.
// Minor command — defense-in-depth; the CLI enforces the schema on the agent side already.

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction as AjvValidateFunction } from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import type { Either } from "fp-ts/Either";
import { FindingsCodec } from "./schema.js";
import type { Findings } from "./schema.js";

const addFormats = _addFormats as unknown as (ajv: Ajv2020) => void;

/** Module-level cache of compiled validators keyed by schema path. */
const validatorCache = new Map<string, AjvValidateFunction>();

/** Compile a JSON Schema validator from the given file path (cached). */
const compileSchema = (schemaPath: string): AjvValidateFunction => {
  const cached = validatorCache.get(schemaPath);
  if (cached) return cached;

  let schemaJson: string;
  try {
    schemaJson = readFileSync(schemaPath, "utf-8");
  } catch {
    throw new Error(`Cannot read schema file: ${schemaPath}`);
  }
  let schema: unknown;
  try {
    schema = JSON.parse(schemaJson);
  } catch {
    throw new Error(`Invalid JSON in schema file: ${schemaPath}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validator = ajv.compile(schema as Record<string, unknown>);
  validatorCache.set(schemaPath, validator);
  return validator;
};

export interface ValidateResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export const validateAgainstSchema = (findings: unknown, schemaPath: string): ValidateResult => {
  const validator = compileSchema(schemaPath);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- ajv returns boolean | Promise<unknown>
  const valid = validator(findings) as boolean;
  const errors: readonly string[] =
    valid || !validator.errors
      ? []
      : validator.errors.map((e) => `${e.instancePath} ${e.message ?? "unknown error"}`);
  return { valid, errors };
};

/** Extract the right value from an io-ts Either, or throw. */
export const unsafeUnwrap = <A>(decoded: Either<unknown, A>): A => {
  if (decoded._tag === "Right") return decoded.right;
  throw new Error("io-ts decode failed — data does not match expected shape");
};

/** Decode findings, throwing on failure. */
export const decodeFindings = (data: unknown): Findings => unsafeUnwrap(FindingsCodec.decode(data));
