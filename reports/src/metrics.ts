/** n / d rounded to 4 decimals, or null when there is nothing to divide by. */
export function ratio(n: number, d: number): number | null {
  if (!(d > 0)) return null;
  return Math.round((n / d) * 10000) / 10000;
}
