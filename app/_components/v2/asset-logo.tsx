/**
 * AssetLogo — the real mark for a traded asset, not an approximation of one.
 *
 * The Options page header used to draw Bitcoin as the Unicode currency sign ₿ (U+20BF)
 * set in the UI font on an orange gradient disc. That is not the Bitcoin logo. The
 * glyph is a different shape from the mark (different bowl proportions, different stem
 * overhang, and it renders differently on every platform because it falls back through
 * whatever font actually ships the codepoint), and the gradient is invented. Next to a
 * live price feed, an asset's identity mark is the one thing on the page a trader
 * recognises before they read anything, so it should be exact.
 *
 * This is the canonical Bitcoin logo: a true circle in the official #F7931A, with the
 * white ₿ counterform, both tilted ~14°, as released into the public domain by its
 * author in 2010 and distributed on bitcoin.org. Geometry verified rather than trusted
 * — the disc path's four on-curve points sit at radius 2045.27 ± 0.39 units around
 * (2045.55, 2045.91), which is the viewBox centre to within a tenth of a unit.
 *
 * Keyed by `AssetConfig` because the whole engine is asset-parametrized (lib/insights/
 * assets.ts) so BTC → ETH is a config change, not a rewrite. Anything without a real
 * mark on file falls back to a plain ticker monogram: an asset we have not drawn yet
 * gets an honest placeholder, never a made-up logo.
 */
import type { AssetConfig } from '@/lib/insights';

export function AssetLogo({ asset, size = 24, className = '' }: { asset: AssetConfig; size?: number; className?: string }) {
  if (asset.id === 'BTC') return <BitcoinMark size={size} className={className} />;
  return <TickerMonogram short={asset.short} size={size} className={className} />;
}

/** The official Bitcoin logo. Public domain. */
function BitcoinMark({ size, className }: { size: number; className: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 4091.27 4091.73"
      width={size}
      height={size}
      role="img"
      aria-label="Bitcoin"
      className={`flex-none ${className}`}
    >
      <path
        fill="#F7931A"
        d="M4030.06 2540.77c-273.24,1096.01 -1383.32,1763.02 -2479.46,1489.71 -1095.68,-273.24 -1762.69,-1383.39 -1489.33,-2479.31 273.12,-1096.13 1383.2,-1763.19 2479,-1489.95 1096.06,273.24 1763.03,1383.51 1489.76,2479.57l0.02 -0.02z"
      />
      <path
        fill="#FFF"
        d="M2947.77 1754.38c40.72,-272.26 -166.56,-418.61 -450,-516.24l91.95 -368.8 -224.5 -55.94 -89.51 359.09c-59.02,-14.72 -119.63,-28.59 -179.87,-42.34l90.16 -361.46 -224.36 -55.94 -92 368.68c-48.84,-11.12 -96.81,-22.11 -143.35,-33.69l0.26 -1.16 -309.59 -77.31 -59.72 239.78c0,0 166.56,38.18 163.05,40.53 90.91,22.69 107.35,82.87 104.62,130.57l-104.74 420.15c6.26,1.59 14.38,3.89 23.34,7.49 -7.49,-1.86 -15.46,-3.89 -23.73,-5.87l-146.81 588.57c-11.11,27.62 -39.31,69.07 -102.87,53.33 2.25,3.26 -163.17,-40.72 -163.17,-40.72l-111.46 256.98 292.15 72.83c54.35,13.63 107.61,27.89 160.06,41.3l-92.9 373.03 224.24 55.94 92 -369.07c61.26,16.63 120.71,31.97 178.91,46.43l-91.69 367.33 224.51 55.94 92.89 -372.33c382.82,72.45 670.67,43.24 791.83,-303.02 97.63,-278.78 -4.86,-439.58 -206.26,-544.44 146.69,-33.83 257.18,-130.31 286.64,-329.61l-0.07 -0.05zm-512.93 719.26c-69.38,278.78 -538.76,128.08 -690.94,90.29l123.28 -494.2c152.17,37.99 640.17,113.17 567.67,403.91zm69.43 -723.3c-63.29,253.58 -453.96,124.75 -580.69,93.16l111.77 -448.21c126.73,31.59 534.85,90.55 468.94,355.05l-0.02 0z"
      />
    </svg>
  );
}

/** Honest placeholder for an asset whose real mark we have not drawn yet. */
function TickerMonogram({ short, size, className }: { short: string; size: number; className: string }) {
  return (
    <span
      role="img"
      aria-label={short}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      className={`grid flex-none place-items-center rounded-full bg-bg-3 font-semibold tracking-tight text-text-2 ring-1 ring-inset ring-line ${className}`}
    >
      {short.slice(0, 3)}
    </span>
  );
}
