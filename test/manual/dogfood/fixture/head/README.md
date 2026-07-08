# range

Tiny range utilities. A range spec is `"lo-hi"`.

- `parseRange(spec)` → `{ lo, hi }`. Supports negative bounds, e.g. `"-5-5"` is `{ lo: -5, hi: 5 }`.
- `inRange(spec, n)` → boolean. **Inclusive on both ends**: `inRange("1-10", 1)` and `inRange("1-10", 10)` are both `true`.
- `clamp(spec, n)` → `n` clamped into `[lo, hi]`.
