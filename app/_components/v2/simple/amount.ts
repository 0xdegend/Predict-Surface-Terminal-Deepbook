/**
 * The bet-amount box's input rule, shared by the desktop ticket and the mobile drawer
 * so a figure typed in one is normalised exactly like the other.
 *
 * What it allows: digits and at most one decimal point, with leading zeros stripped
 * ("05" → "5", "010" → "10") — but "0." kept, so a sub-dollar amount is still typeable.
 *
 * The box holds a STRING, not a number, and that's the point. A controlled numeric input
 * can NOT clean up "010" on its own: `Number("010")` is the 10 already in state, so React
 * sees an unchanged `value` prop and leaves the raw text sitting there. Normalising the
 * text itself is the only fix that holds.
 */
export function sanitizeAmount(raw: string): string {
  const digits = raw.replace(/[^0-9.]/g, '');
  const dot = digits.indexOf('.');
  const oneDot = dot < 0 ? digits : `${digits.slice(0, dot + 1)}${digits.slice(dot + 1).replace(/\./g, '')}`;
  return oneDot.replace(/^0+(?=\d)/, '');
}
