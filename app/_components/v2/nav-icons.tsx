'use client';

/**
 * nav-icons — the More menu's icon set, as hand-authored SVGs that animate on hover.
 *
 * Geometry is Lucide's, kept verbatim, so these sit next to the Lucide icons still used
 * elsewhere in the app without looking like a second icon family. What's added is
 * structure: each glyph splits its paths into named parts so a part can be animated on
 * its own, which a packaged <LuRoute /> can't do because it renders one opaque blob.
 *
 * The motion vocabulary is deliberately small, so ten icons read as one set rather than
 * ten toys. Every icon uses exactly one of:
 *
 *   draw   — a stroke drawing itself in (route, check, trend line)
 *   lift   — a staggered rise (candle bodies)
 *   pulse  — concentric rings expanding outward (target, shield alert)
 *   turn   — a small rotation (key, swords)
 *   open   — a hinge/nudge (book, message tail)
 *
 * Timing, easing and the reduced-motion opt-out live in ONE place (`.nav-ico-*` in
 * globals.css), not per icon, so the set can be retuned without touching this file.
 *
 * Every drawn path carries `pathLength={1}`. That normalises the path to a length of 1
 * for dash maths, so a single `stroke-dasharray: 1` always covers the whole stroke no
 * matter how long the real geometry is. The first cut of this hardcoded a dash length
 * per path, and the route's guess (34) was short of its true length (50), so the dash
 * REPEATED and the icon rendered permanently broken into pieces. There is no number to
 * get wrong now, and editing a path's `d` can never resurrect the bug.
 *
 * Each export is typed as `IconType`, the same shape react-icons uses, so they drop
 * straight into the navs' existing `icon:` field with no other change at the call site.
 * They animate off `group-hover`, so the tile that renders one must carry `group`.
 */
import type { IconType } from 'react-icons';

/** Shared frame: Lucide's viewBox, stroke weight and linecaps, so weights match exactly. */
function Svg({ size = 16, className = '', children }: { size?: string | number; className?: string; children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`nav-ico ${className}`}
    >
      {children}
    </svg>
  );
}

/** BTC Options — the two candles rise on a stagger, wicks draw after them. */
export const IcoOptions: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <g className="nav-ico-lift" style={{ ['--d' as string]: '0ms' }}>
      <path d="M9 5v4" />
      <rect width="4" height="6" x="7" y="9" rx="1" />
      <path d="M9 15v2" />
    </g>
    <g className="nav-ico-lift" style={{ ['--d' as string]: '70ms' }}>
      <path d="M17 3v2" />
      <rect width="4" height="8" x="15" y="5" rx="1" />
      <path d="M17 13v3" />
    </g>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
  </Svg>
);

/** Kelly — the bubble's tail drops as if a reply just arrived. */
export const IcoKelly: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <path className="nav-ico-open" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Svg>
);

/** Autopilot — the route draws itself between the two waypoints, hands-free. */
export const IcoAutopilot: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <circle cx="6" cy="19" r="3" />
    <path className="nav-ico-draw" pathLength={1} d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
    <circle cx="18" cy="5" r="3" />
  </Svg>
);

/** Kelly's Record — the check signs itself onto the page. */
export const IcoRecord: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path className="nav-ico-draw" pathLength={1} d="m9 15 2 2 4-4" />
  </Svg>
);

/** Vault Risk — the alert mark pulses inside a shield that stays put. */
export const IcoRisk: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <g className="nav-ico-pulse" style={{ ['--d' as string]: '0ms' }}>
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </g>
  </Svg>
);

/** Analytics — the trend line draws in over its bars. */
export const IcoAnalytics: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <path d="M12 16v5" />
    <path d="M16 14v7" />
    <path d="M20 10v11" />
    <path
      className="nav-ico-draw"
      pathLength={1}
      d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15"
    />
    <path d="M4 18v3" />
    <path d="M8 14v7" />
  </Svg>
);

/** Quests — the rings pulse outward from the bullseye. */
export const IcoQuests: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <circle className="nav-ico-pulse" style={{ ['--d' as string]: '120ms' }} cx="12" cy="12" r="10" />
    <circle className="nav-ico-pulse" style={{ ['--d' as string]: '60ms' }} cx="12" cy="12" r="6" />
    <circle className="nav-ico-pulse" style={{ ['--d' as string]: '0ms' }} cx="12" cy="12" r="2" />
  </Svg>
);

/** Degen Arena — the blades cross. Each turns about its own hilt, opposite ways. */
export const IcoArena: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <g className="nav-ico-turn" style={{ ['--deg' as string]: '-8deg', ['--ox' as string]: '4px', ['--oy' as string]: '20px' }}>
      <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" />
      <line x1="13" x2="19" y1="19" y2="13" />
      <line x1="16" x2="20" y1="16" y2="20" />
      <line x1="19" x2="21" y1="21" y2="19" />
    </g>
    <g className="nav-ico-turn" style={{ ['--deg' as string]: '8deg', ['--ox' as string]: '20px', ['--oy' as string]: '20px' }}>
      <polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5" />
      <line x1="5" x2="9" y1="14" y2="18" />
      <line x1="7" x2="4" y1="17" y2="20" />
      <line x1="3" x2="5" y1="19" y2="21" />
    </g>
  </Svg>
);

/** Docs — the book opens a little further on its spine. */
export const IcoDocs: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <path d="M12 7v14" />
    <path
      className="nav-ico-open"
      d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"
    />
  </Svg>
);

/** Admin — the key turns in the lock. */
export const IcoAdmin: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <g className="nav-ico-turn" style={{ ['--deg' as string]: '-12deg', ['--ox' as string]: '16.5px', ['--oy' as string]: '7.5px' }}>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </g>
  </Svg>
);

/** Vault — the dial spokes turn, like a handle being worked. The door stays still. */
export const IcoVault: IconType = ({ size, className }) => (
  <Svg size={size as number} className={className as string}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <g className="nav-ico-turn" style={{ ['--deg' as string]: '20deg', ['--ox' as string]: '12px', ['--oy' as string]: '12px' }}>
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
      <path d="m7.9 7.9 2.7 2.7" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
      <path d="m13.4 10.6 2.7-2.7" />
      <circle cx="7.5" cy="16.5" r=".5" fill="currentColor" />
      <path d="m7.9 16.1 2.7-2.7" />
      <circle cx="16.5" cy="16.5" r=".5" fill="currentColor" />
      <path d="m13.4 13.4 2.7 2.7" />
      <circle cx="12" cy="12" r="2" />
    </g>
  </Svg>
);
