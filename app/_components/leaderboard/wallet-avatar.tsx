'use client';

/**
 * WalletAvatar — a Jazzicon-style identicon rendered from an address: a base
 * fill with a few rotated, offset color shards clipped to a circle, plus a soft
 * top-light so the disc reads as a lit sphere. Fully deterministic (same address
 * → same art) and allocation-free after mount. Shared by the leaderboard and the
 * trader profile so a trader's avatar is identical everywhere.
 */

// Identicon palette — harmonized with the app's icon hues so the wallet
// jazzicons feel native to the terminal rather than a stock widget.
const JAZZ_PALETTE = ['#4dd6b0', '#6aa6e6', '#9d92e8', '#d9a94e', '#f0796b', '#5fc9c0', '#b08be0', '#e0a36a'];

/** Tiny deterministic PRNG (mulberry32) so an avatar is stable per address. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function WalletAvatar({ addr, size, ring }: { addr: string; size: number; ring: string }) {
  let seed = 0;
  for (let i = 2; i < addr.length; i++) seed = (seed * 31 + addr.charCodeAt(i)) >>> 0;
  const rng = mulberry32(seed);
  const offset = Math.floor(rng() * JAZZ_PALETTE.length);
  const palette = JAZZ_PALETTE.slice(offset).concat(JAZZ_PALETTE.slice(0, offset));

  const center = size / 2;
  const clipId = `jz-clip-${seed.toString(36)}`;
  const sheenId = `jz-sheen-${seed.toString(36)}`;
  const shapeCount = 4;
  const shards = Array.from({ length: shapeCount }, (_, i) => {
    const firstRot = rng();
    const angle = Math.PI * 2 * firstRot;
    const velocity = (size / shapeCount) * rng() + (i * size) / shapeCount;
    const tx = Math.cos(angle) * velocity;
    const ty = Math.sin(angle) * velocity;
    const rot = firstRot * 360 + rng() * 180;
    return (
      <rect
        key={i}
        width={size}
        height={size}
        fill={palette[(i + 1) % palette.length]}
        transform={`translate(${tx.toFixed(2)} ${ty.toFixed(2)}) rotate(${rot.toFixed(1)} ${center} ${center})`}
      />
    );
  });

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      style={{ borderRadius: '50%', boxShadow: `0 0 0 1px ${ring}`, display: 'block' }}
    >
      <clipPath id={clipId}>
        <circle cx={center} cy={center} r={center} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect width={size} height={size} fill={palette[0]} />
        {shards}
        {/* soft top-light so the disc reads as a lit sphere, not a flat puck */}
        <rect width={size} height={size} fill={`url(#${sheenId})`} />
      </g>
      <defs>
        <radialGradient id={sheenId} cx="32%" cy="26%" r="75%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.32)" />
          <stop offset="42%" stopColor="rgba(255,255,255,0.04)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.28)" />
        </radialGradient>
      </defs>
    </svg>
  );
}
