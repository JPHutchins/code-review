// The cycle-safe in_reply_to climb, shared by the answered-registry walk and the discussion-aside
// walk so the cycle-guard semantics live in one place. The climb terminates at a gap: a dangling
// parent id (a deleted comment whose replies keep pointing at it) ends the chain where the map
// stopped — both consumers accept that a severed subtree stays out of their grouping.
export function* ancestors<T>(start: T, parentOf: (node: T) => T | null): Generator<T> {
  const seen = new Set<T>();
  let current: T | null = start;
  while (current !== null && !seen.has(current)) {
    yield current;
    seen.add(current);
    current = parentOf(current);
  }
}
