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
  A frozen copy is never edited again — with ONE deliberate exception: the frozen `v0.9` copy also
  accepts the tolerant-in `id` spellings (`id`, `finding_ids`, `ids`) its legacy codec accepts, so
  the ajv gate and the codec gate agree on the hybrid doc a mid-transition reviewer produces (new
  field, old version stamp).

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
| `v0.6.0` | superseded | Adds optional `systemic_problems` — an array of cross-cutting observations that tie findings together and are hard to express with a line range, each item with required `title`/`description`/`severity`/`reasoning`/`confidence` and optional `code`/`code_url`/`finding_codes`/`paths` (no line anchors). Refocuses `summary` on justifying the overall verdict rather than restating findings. Backwards-compatible (a `0.5` document is a valid `0.6` document); the CLI keeps resolving `0.4`/`0.5` via identity upcasts. |
| `v0.9.0` | superseded (frozen at `schema/v0.9/`) | Adds a REQUIRED `likelihood` (0..1) to every finding and systemic problem (issue #163): the probability the triggering input/state actually occurs — distinct from `confidence` (whether the defect is real) — folded into the convergence score as a second multiplier. **Breaking**: a pre-0.9 document lacks `likelihood` and no longer validates, so a stale sticky degrades to a sentinel-only seed (one cold re-review) rather than seeding. The draft axis skips `0.7`/`0.8`: those are the surface-signal axis's versions (below), so the draft jumps past them to keep the two version spaces distinct — a draft must never be mistaken for a legacy surfaced blob (issue #156). |
| `v0.10.0` | **current** | Renames the mechanism identifier `code` → `id` and makes it **required** on every finding (issue #246), so every finding is always trackable across rounds and discussions. Systemic problems rename `code`/`finding_codes` → `id`/`finding_ids`; convergence rounds rename `codes` → `ids`; `scope_metastasis.recurring` renames `code` → `id`. `change_size.code` (the role bucket) and `code_url` keep their names. **Breaking**: a pre-0.10 document lacks `id` — the registry upcasts every pre-0.10 minor through one tolerant legacy codec (`code` → `id`, or a synthesized content-derived id — sha256 of path+title — when a finding carried none), so a legacy sticky still seeds a re-review with its ids intact, and the pre-0.10 shape stays frozen at `schema/v0.9/` (above). |

### Surface channel (stop signal)

The commenter embeds the agent's **complete** findings document verbatim in review comments
(`<!-- code-review:findings-json -->`) — no surfaced copy, no added fields (issue #156). The
deterministic stop signal an iterating author-agent needs is the pipeline-stamped `convergence` field
INSIDE that document (issue #174): `{score, threshold, converged}` (a literal boolean, so a decoding
agent cannot re-derive the weights) plus the per-round `rounds` trajectory. It is the single source of
truth — the agent never writes it (it cannot know the score; the weights and threshold are
commenter-side), and the findings schema above describes the whole embedded document, `convergence`
included. When an oversized review falls to the link form (the blob is a URL, not base64), the same
stamped object rides a compact `<!-- code-review:convergence -->` marker beside the link (issue #185)
so the trajectory and stop signal survive; the embedded blob always wins on read.

Two older surface formats survive only as READ-ONLY migration inputs — a re-review may still parse a
sticky posted by an earlier release. Nothing writes either anymore:

| Version | Status | Notes |
|---|---|---|
| `v0.7.0` | legacy (read-only) | The pre-#156 surface axis: the commenter embedded a **surfaced** copy of the findings document carrying `convergence` + `round` inside it (issue #141). A sticky written by a `0.7.0` release still seeds — `stripSurfaceFields` peels the surfaced copy back to the agent's draft. |
| `v0.8.0` | legacy (read-only) | The version a compact `<!-- code-review:signal -->` marker declared (and a legacy `0.8.0` surfaced blob). Its writer is retired (issue #186); `parseSignalMarker` / `parseSurfaceSignal` still decode it so a pre-#185 sticky seeds. `0.8.0` also added the agent-facing `scope_metastasis` entry (issue #150): per-code consecutive-round recurrence counts plus a decision prompt. Post-#156 that entry is embedded in no document — the re-review seed re-derives it from the carried trajectory. The flat draft schema (now `v0.9.0`) accepts an optional `scope_metastasis` property so a seed-echoing draft validates — an in-place additive change, deliberately NOT a draft version bump: a draft sharing a `0.7.0`/`0.8.0` number would collide with the surface axis's version gate, so the draft axis skips past them to `0.9.0` (issue #163); the axes must stay distinct so `stripSurfaceFields`/`parseSurfaceSignal` can tell a legacy surfaced blob from a draft). |

The surface axis is independent of the draft-version registry: it numbers the legacy read-only signal
formats, while the agent-written document above is `v0.9.0`. `stripSurfaceFields` and
`parseSurfaceSignal` are version-gated on the surface axis, so a future draft bump can never be
mistaken for a legacy surfaced blob — and no fresh document is ever surfaced.

### Price-map schema

[`prices.schema.json`](prices.schema.json) is versioned separately from the findings schema (it
evolves with provider pricing, not with the review contract). It follows the same semver + `$id`
policy; the `main` `$id` tracks latest, tagged releases pin to the version. Its current version:

| Version | Status | Notes |
|---|---|---|
| `v0.1.0` | superseded | Initial price-map schema. Per-model `in`/`out`/`cache_read`/`cache_write` (USD per 1M tokens); `_updated` date; `_unit`. |
| `v0.2.0` | superseded | A model's value is now a `oneOf` (issue #170): the flat shape above, OR `{ "slots": [ { "utc_from", "utc_to", "in", "out", "cache_read", "cache_write" } ] }` — UTC time-of-day pricing (half-open `[utc_from, utc_to)` windows; `utc_to <= utc_from` wraps past midnight; slots must partition the 24h day). Additive/backward-compatible: every flat map keeps validating. |
| `v0.3.0` | **current** | Optional `weekend_slots` beside `slots` (issue #216): a second partition, same shape and same 24h-partition requirement, selected on Saturdays and Sundays in **Beijing** time (Friday 16:00 UTC → Sunday 16:00 UTC — a day-of-week rule, not a timezone axis). A model without it uses `slots` every day. Additive for readers that know the key; see the delivery rule below for readers that do not. |

The `_updated` field inside a price-map instance tracks **price drift** (a data concern) and is
distinct from the schema's semver version (a **contract** concern). Adding a new price field (e.g. a
future `cache_write_5m`) is a MINOR schema bump; updating a price value is only an `_updated`
change.

Every rate in a map states **current** pricing. Recomputing an old envelope reprices it at today's
rates, so a cost recomputed long after the run is not a record of what was billed — this applies to
the `weekend_slots` axis exactly as it applies to the numbers.

#### Adding a key to a shipped map: the delivery-order rule

A price map and the CLI that reads it travel by **different routes**. `.github/prices.json` is read
from the default-branch checkout and takes effect the moment it merges; the CLI is installed from
npm at the pinned `CODE_REVIEW_VERSION` and takes effect only when a release ships. The price codecs
are strict-keyed by design (`SlottedModelPricesStrict` requires every key to be `slots`), so a map
carrying a key the pinned CLI predates does not degrade — `PriceMapCodec` returns `Left` and `post`
throws, taking down every review between the merge and the release.

So a map key MUST NOT reach the default branch before the CLI that parses it:

1. Merge the codec, schema, and tests on their own — safe in any order, since a newer CLI reads
   every older map.
2. Put the **data** change in the release commit itself, beside the `CODE_REVIEW_VERSION` bump, so
   the map and the CLI that understands it land in the same commit and the same tag.
3. Only then roll consumers — pin and map together, one commit each (a consumer's map is copied
   from the tag).

Verify before merging a map change: install the pinned version and decode the new map with it —
`npx @jphutchins/code-review@$CODE_REVIEW_VERSION cost <envelope> --prices <new-map>` prints a cost
if the pinned CLI accepts it and `prices does not match expected shape` if it does not.

## Compatibility with CLI structured-output enforcement

The schema is **inlined** — no `$ref`, `$defs`, or `$id` fragments. This is an intentional
constraint: some CLI structured-output modes (e.g. `claude -p --json-schema`) may not resolve
references, so the same file must work for both JSON-Schema validators and CLI enforcement.

If a future version adds `$ref`/`$defs`, a **flattened variant** SHALL be published alongside
it for CLI use, and the inlined variant SHALL carry the canonical `$id`.
