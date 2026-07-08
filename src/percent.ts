// Small helper for rendering computed progress percentages.

/** Clamp `n` into the inclusive percentage range [0, 100]: values below 0 become 0, values above
 *  100 become 100. Keeps a computed progress percentage safe to render. */
export const clampPercent = (n: number): number => Math.min(100, n);
