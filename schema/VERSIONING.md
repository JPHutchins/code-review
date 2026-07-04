# Schema versioning

The [findings schema](findings.schema.json) follows [Semantic Versioning 2.0.0](https://semver.org).

## In-data conformance signal

A findings object carries a `schema_version` string (e.g. `"0.1.0"`) declaring which schema version
it conforms to. This is the **runtime** conformance signal: it lets a commenter detect a version
mismatch (and demote/notify) rather than silently dropping or misinterpreting fields. It is distinct
from the schema file's `$id`, which is the schema's own identity URI.

## Version policy

- **MAJOR** — backwards-incompatible changes: removing a required property, changing a type, adding
  new required properties, narrowing an enum.
- **MINOR** — backwards-compatible additions: adding optional properties, widening an enum,
  relaxing a constraint.
- **PATCH** — backwards-compatible fixes: description/annotation changes, constraint tightening
  that doesn't affect valid data (e.g. adding `additionalProperties: false` to a sub-object that
  already had all properties declared).

> **Pre-1.0 latitude:** while the major version is `0`, adding a required property is treated as a
> MINOR bump (the 0.x line does not promise stability). Once `1.0.0` ships, adding a required
> property becomes a MAJOR bump.

## `$id` URI

The `$id` in each schema revision SHALL point to the tagged, immutable copy:

```
https://raw.githubusercontent.com/JPHutchins/code-review/v<version>/schema/findings.schema.json
```

The file on `main` carries the moving `main` ref until a version tag is cut. **At release time the
`$id` MUST be updated to the tag** (a CI check or release step verifies the `$id` matches the tag —
see the release checklist below); a tagged schema MUST NOT self-identify as `main`. Two distinct
versions carrying the same `$id` violates REQ-SC-3.

### Release checklist

1. Bump `schema_version` (the default in examples/fixtures) and the schema `$id` to the new tag.
2. Add a row to the Published versions table.
3. Tag the release; the CI check confirms the `$id` in the tag matches the tag name.
4. Restore the `main` `$id` on the post-release `main` commit.

## Published versions

| Version | Status | Notes |
|---|---|---|
| `v0.1.0` | superseded | Initial schema. Matches the proven camas reference implementation. |
| `v0.2.0` | **current** | Adds required `schema_version`; optional `code`/`code_url` finding fields; normative `suggestion` `""`/`null` semantics; abstract vendor-neutral envelope (see SPEC §6.1). |

### Price-map schema

[`prices.schema.json`](prices.schema.json) is versioned separately from the findings schema (it
evolves with provider pricing, not with the review contract). It follows the same semver + `$id`
policy; the `main` `$id` tracks latest, tagged releases pin to the version. Its current version:

| Version | Status | Notes |
|---|---|---|
| `v0.1.0` | **current** | Initial price-map schema. Per-model `in`/`out`/`cache_read`/`cache_write` (USD per 1M tokens); `_updated` date; `_unit`. |

The `_updated` field inside a price-map instance tracks **price drift** (a data concern) and is
distinct from the schema's semver version (a **contract** concern). Adding a new price field (e.g. a
future `cache_write_5m`) is a MINOR schema bump; updating a price value is only an `_updated`
change.

## Compatibility with CLI structured-output enforcement

The schema is **inlined** — no `$ref`, `$defs`, or `$id` fragments. This is an intentional
constraint: some CLI structured-output modes (e.g. `claude -p --json-schema`) may not resolve
references, so the same file must work for both JSON-Schema validators and CLI enforcement.

If a future version adds `$ref`/`$defs`, a **flattened variant** SHALL be published alongside
it for CLI use, and the inlined variant SHALL carry the canonical `$id`.
