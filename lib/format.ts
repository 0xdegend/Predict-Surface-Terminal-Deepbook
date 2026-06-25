/**
 * lib/format.ts — the ONE number/text formatting util (§10.7).
 * Fixed precision per field, comma thousands, signed+colored PnL, truncated
 * addresses. Everything that renders a number should route through here so columns
 * never jitter and precision stays consistent.
 */

const THOUSANDS_SEP = ',';

function groupThousands(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEP);
}

/** Generic fixed-decimal with comma grouping. */
export function num(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const [int, frac] = Math.abs(value).toFixed(decimals).split('.');
  const grouped = groupThousands(int);
  return frac ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/**
 * Compact magnitude for tight spaces (e.g. stat strips on mobile) — 19_978.7 →
 * "19.98K", 1_250_000 → "1.25M". Values below 1,000 render in full so small
 * counts never round to a surprising figure. Trailing zeros are trimmed.
 */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs < 1000) return num(value, Number.isInteger(value) ? 0 : 2);
  for (const [base, suffix] of [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ] as const) {
    if (abs >= base) return `${parseFloat((value / base).toFixed(2))}${suffix}`;
  }
  return num(value, 2);
}

/** USD-style price (underlying spot/forward/strike). */
export function price(value: number, decimals = 2): string {
  return num(value, decimals);
}

/** DUSDC amount with symbol. */
export function quote(value: number, decimals = 2): string {
  return `${num(value, decimals)}`;
}

/**
 * A fee amount, which can be much smaller than the 2-decimal currency grid (a 1%
 * fee on a 0.42 bet is 0.0042). Shows the normal 2-decimal format at ≥ 0.01, but
 * for tiny fees keeps ~2 significant figures (0.0043, 0.00043) so it never
 * collapses to "0.00". Capped at DUSDC's 6-decimal precision; trailing zeros
 * trimmed.
 */
export function feeAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0.00';
  if (value >= 0.01) return num(value, 2);
  // 2 significant figures, then drop any trailing zeros (e.g. 0.0000010 → 0.000001)
  return String(parseFloat(value.toPrecision(2)));
}

/** Implied vol / ratios as a percentage. */
export function pct(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${num(value * 100, decimals)}%`;
}

/** Signed value with explicit + for positives (for PnL). */
export function signed(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '—';
  const s = num(Math.abs(value), decimals);
  return value < 0 ? `-${s}` : `+${s}`;
}

/** Truncate a Sui address/object id: 0x1234…cdef */
export function shortId(id: string, head = 6, tail = 4): string {
  if (!id) return '';
  const clean = id.startsWith('0x') ? id : `0x${id}`;
  if (clean.length <= head + tail + 2) return clean;
  return `${clean.slice(0, head)}…${clean.slice(-tail)}`;
}

/** ms-epoch → compact UTC time, e.g. "14:32:05 UTC". */
export function timeUTC(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} UTC`;
}

/** ms-epoch → "Jun 03 14:32 UTC" for expiries. Pass `zone=false` to drop the
 *  " UTC" suffix where the surrounding context already implies it (e.g. the
 *  dense position card). */
export function dateUTC(ms: number, zone = true): string {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${day} ${hh}:${mm}${zone ? ' UTC' : ''}`;
}

/** Time-to-expiry as compact "2h 14m" / "—" if past. */
export function ttl(expiryMs: number, nowMs: number = Date.now()): string {
  const diff = expiryMs - nowMs;
  if (diff <= 0) return 'expired';
  const totalMin = Math.floor(diff / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Live countdown — like `ttl`, but resolves to the second under an hour so a
 * ticking clock reads naturally ("14m 03s", "45s"). Falls back to ttl's coarse
 * form above an hour where seconds are noise.
 */
export function countdown(expiryMs: number, nowMs: number = Date.now()): string {
  const diff = expiryMs - nowMs;
  if (diff <= 0) return 'expired';
  const totalSec = Math.floor(diff / 1000);
  if (totalSec >= 3600) return ttl(expiryMs, nowMs);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Compact "time since" for a past ms-epoch — "now" / "12s" / "4m" / "2h" / "3d".
 *  Drives the live flow tape's age column (recompute on a ticking clock). */
export function ago(tsMs: number, nowMs: number = Date.now()): string {
  const diff = nowMs - tsMs;
  if (diff < 5_000) return 'now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
