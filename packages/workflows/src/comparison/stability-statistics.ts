/** Statistics use cases as independent units. Repeated judge calls never inflate n. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function exactSignTest(differences: readonly number[]) {
  if (differences.some(value => !Number.isFinite(value))) throw new Error("Sign test requires finite case differences");
  const positive = differences.filter(value => value > 0).length;
  const negative = differences.filter(value => value < 0).length;
  const n = positive + negative;
  if (!n) return { status: "no_nonzero_differences", n, positive, negative, zero: differences.length, p_value: null };
  // Exact two-sided Binomial(n, .5); the pilot admits at most 12 independent cases.
  let term = 2 ** -n, tail = term;
  for (let k = 1; k <= Math.min(positive, negative); k++) { term *= (n - k + 1) / k; tail += term; }
  return { status: "exploratory", n, positive, negative, zero: differences.length - n, p_value: Math.min(1, 2 * tail) };
}

export function caseBootstrap(values: readonly number[], seed: number, draws = 2000) {
  if (values.some(value => !Number.isFinite(value))) throw new Error("Bootstrap requires finite case values");
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  if (values.length < 2) return { status: "insufficient_cases", n: values.length, mean, interval_95: null };
  if (values.every(value => value === values[0]))
    return { status: "no_observed_variation", n: values.length, mean, interval_95: null };
  const random = seededRandom(seed), means: number[] = [];
  for (let draw = 0; draw < draws; draw++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return { status: "exploratory", n: values.length, mean,
    interval_95: [means[Math.floor(draws * .025)]!, means[Math.ceil(draws * .975) - 1]!] };
}

export function outcomeDistribution(values: readonly (string | null)[]) {
  const counts: Record<string, number> = {};
  for (const value of values) if (value !== null) counts[value] = (counts[value] ?? 0) + 1;
  const completed = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { completed, unresolved: values.length - completed, counts,
    unanimous: completed === values.length && completed > 0 && Object.keys(counts).length === 1 };
}
