export const parseRange = (spec) => {
  const parts = spec.split("-");
  const lo = Number(parts[0]);
  const hi = Number(parts[1]);
  return { lo, hi };
};

export const inRange = (spec, n) => {
  const { lo, hi } = parseRange(spec);
  return n >= lo && n <= hi;
};
