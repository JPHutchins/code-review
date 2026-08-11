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
https://raw.githubusercontent.com/JPHutchins/code-review/schema-v<version>/schema/findings.schema.json
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

## Bundled versioned copies (runtime multi-version)

The published npm package bundles a JSON-schema file for **every findings-schema minor the CLI
still supports**, so a findings object declaring an older `schema_version` keeps validating after a
newer version ships. This is distinct from the git-tag `$id` mechanism above:

- The **latest** version lives flat at `schema/<kind>.schema.json` and carries the moving `/main/`
  `$id` (the package-release guard requires this).
- When a version stops being latest, it is **frozen** to `schema/v<major.minor>/<kind>.schema.json`
  with its `$id` pinned to that version's schema-release tag
  (`https://raw.githubusercontent.com/JPHutchins/code-review/schema-v<version>/schema/<kind>.schema.json`).
  A frozen copy is never edited again.

The CLI's registry (`src/registry.ts`) maps each supported `major.minor` to its bundled file, codec,
and upcast normalizer. Dispatch is by the `major.minor` of the document's `schema_version` (patch is
ignored); a version outside the supported set degrades to a §5.5 sticky notice.

## Published versions

| Version | Status | Notes |
|---|---|---|
| `v0.1.0` | superseded | Initial schema. Matches the proven camas reference implementation. |
| `v0.2.0` | superseded | Adds required `schema_version`; optional `code`/`code_url` finding fields; normative `suggestion` `""`/`null` semantics; abstract vendor-neutral envelope (see SPEC §6.1). |
| `v0.3.0` | superseded | Adds optional `reasoning` finding field. |
| `v0.4.0` | superseded | Breaking: renames finding `body` → `description`; makes `reasoning` and `confidence` **required**; adds optional `recommendation` (prose fix); removes the free-text `suggestion` field (a `patch`, now `string \| null`, is the sole mechanical fix, projected into a suggestion by the commenter). |
| `v0.5.0` | superseded | Widens the `verdict` enum with a pipeline-reserved `error` value: a run that produced no verdict about the diff (operational failure or security refusal) now carries `verdict: "error"` with `findings: []`, so its machine-readable blob is no longer byte-identical to a clean pass. Backwards-compatible (a `0.4` document is a valid `0.5` document); the CLI keeps resolving `0.4` via an identity upcast, so a sticky embedded by a `0.4` CLI still seeds a re-review. |
| `v0.6.0` | **current** | Adds optional `systemic_problems` — an array of cross-cutting observations that tie findings together and are hard to express with a line range, each item with required `title`/`description`/`severity`/`reasoning`/`confidence` and optional `code`/`code_url`/`finding_codes`/`paths` (no line anchors). Refocuses `summary` on justifying the overall verdict rather than restating findings. Backwards-compatible (a `0.5` document is a valid `0.6` document); the CLI keeps resolving `0.4`/`0.5` via identity upcasts, so stickies embedded by earlier CLIs still seed a re-review. |

### Surfaced findings document

The commenter does not embed the agent's raw findings document in review comments — it embeds a
**surfaced** copy (`<!-- code-review:findings-json -->`): the same fields, stamped with a surface
version and the pipeline-computed `convergence` (`{score, threshold, converged}` — a literal
boolean, so a decoding agent cannot re-derive the weights) and `round` (the count of completed
full-review rounds) of the last completed full-review round. The agent never writes these fields
(it cannot know the score — the weights and threshold are commenter-side), so the findings schema
above describes only the agent-written document; the surfaced document has its own version axis:

| Version | Status | Notes |
|---|---|---|
| `v0.7.0` | superseded | The surfaced document carries `convergence` + `round` — the deterministic stop signal an iterating author-agent decodes instead of the prose (issue #141). Both are omitted until at least one full-review round has completed, and both survive the in-progress banner (carried forward verbatim with the marker). `stripSurfaceFields` drops them when a surfaced blob feeds back into the agent channel (the re-review seed), restoring the draft version. This surface axis is deliberately **distinct** from the draft axis (now `v0.6.0` after issue #134) so a surfaced doc is never mistaken for an agent-written draft. |
| `v0.8.0` | **current** | Adds the agent-facing `scope_metastasis` entry (issue #150): per-code consecutive-round recurrence counts plus a decision prompt, computed from the same rounds history the prose metastasis note renders. Unlike `convergence`/`round` it is NOT stripped by `stripSurfaceFields` — the re-review seed must deliver the recurrence data to the next-round agent, so the agent can respond to the scope decision instead of letting the end state emerge piecemeal. To tolerate a seed-echoing draft, the flat draft schema (still `v0.6.0`) additionally accepts an optional `scope_metastasis` property — an in-place additive change, deliberately NOT a draft version bump: a `0.7.0` draft would collide with the surfaced axis's version gate (the axes must stay distinct so `stripSurfaceFields`/`parseSurfaceSignal` can tell a surfaced doc from a draft). |

The surfaced axis is independent of the draft-version registry: `v0.8.0` is the surface shape's
marker contract, while the agent-written document above remains at `v0.6.0`. `stripSurfaceFields`
and `parseSurfaceSignal` are version-gated on the surface axis, so a future draft bump can never be
mistaken for a surfaced document.

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
