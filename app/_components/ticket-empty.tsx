'use client';

/**
 * TicketEmpty — the trade ticket's "not connected yet" state. Replaces a bare
 * line of text with a glassmorphic card that (a) shows a little live "surface
 * node" motif so the core gesture (click a point on the vol surface to mint) is
 * legible at a glance, (b) lays out the two onboarding steps, and (c) offers a
 * view-aware tip toward the other hero view (Surface ↔ Chart).
 *
 * Everything is `heroView`-aware (same store the TicketTitle reads) so the
 * guidance always matches what's actually clickable on the hero, and the tip
 * points at the real top-left view toggle with its matching icon. Pure
 * presentational + the store read; no wallet logic (the top-nav WalletBar owns
 * connection).
 */
import type { IconType } from 'react-icons';
import { LuWallet, LuMousePointerClick, LuList, LuChartArea, LuBoxes } from 'react-icons/lu';
import { useSurfaceStore } from '@/lib/store/surface-store';

export function TicketEmpty() {
  const heroView = useSurfaceStore((s) => s.heroView);
  const isChart = heroView === 'chart';

  // Step 2 — how to pick a market, adapted to the active hero view. The odds
  // list lives in the rail in both views, so it's always an option.
  const pickHint = isChart
    ? 'Tap an active market in the odds list'
    : 'Click a node on the surface, or an active market';
  const PickIcon = isChart ? LuList : LuMousePointerClick;

  // Tip — point at the OTHER hero view (the real top-left toggle + its icon).
  const tipTitle = isChart ? 'Want the 3-D surface back?' : 'Prefer reading charts?';
  const tipHint = isChart ? 'Switch to Surface (top-left)' : 'Switch to Chart (top-left)';
  const TipIcon = isChart ? LuBoxes : LuChartArea;

  return (
    <div className="glass-card relative overflow-hidden rounded-2xl p-5">
      {/* the one off-canvas accent wash, bled in from the top-right corner */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(125% 95% at 100% 0%, var(--accent-soft), transparent 55%)' }}
      />

      {/* surface-node motif */}
      <div className="relative flex justify-center pb-1 pt-1">
        <SurfaceNodeGlyph />
      </div>

      <div className="relative mt-1 text-center">
        <h3 className="text-[15px] font-semibold tracking-tight text-text-1">
          {isChart ? 'Pick a market to trade' : 'Click the surface to trade'}
        </h3>
        <p className="mx-auto mt-1.5 max-w-[16rem] text-[13px] leading-relaxed text-text-2">
          Connect a wallet, then pick a market — from the live surface, the odds list, or the chart —
          to mint a position.
        </p>
      </div>

      {/* two-step onboarding + an optional view tip */}
      <div className="relative mt-4 flex flex-col gap-2">
        <Step n={1} icon={LuWallet} title="Connect your wallet" hint="Top-right of the screen" />
        <Step n={2} icon={PickIcon} title="Pick a market to trade" hint={pickHint} />
        <TipRow icon={TipIcon} title={tipTitle} hint={tipHint} />
      </div>
    </div>
  );
}

function Step({
  n,
  icon: Icon,
  title,
  hint,
}: {
  n: number;
  icon: IconType;
  title: string;
  hint: string;
}) {
  return (
    <div className="glass-inset flex items-center gap-3 rounded-xl px-3 py-2.5">
      <span
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full font-mono text-[11px] font-semibold text-[var(--accent)]"
        style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}
      >
        {n}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium leading-none text-text-1">{title}</span>
        <span className="text-[11px] leading-none text-text-3">{hint}</span>
      </span>
      <Icon size={15} className="flex-none text-text-3" />
    </div>
  );
}

/** Optional aside — visually distinct from the numbered steps (neutral icon
 *  marker + a quiet "Tip" tag) so it reads as a suggestion, not a step. */
function TipRow({ icon: Icon, title, hint }: { icon: IconType; title: string; hint: string }) {
  return (
    <div className="glass-inset flex items-center gap-3 rounded-xl px-3 py-2.5 opacity-90">
      <span
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line-soft)' }}
      >
        <Icon size={13} className="text-text-2" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium leading-none text-text-1">{title}</span>
        <span className="text-[11px] leading-none text-text-3">{hint}</span>
      </span>
      <span className="eyebrow flex-none">Tip</span>
    </div>
  );
}

/**
 * A compact perspective wireframe of the vol surface with one glowing node and a
 * cursor about to click it — the product's core gesture, drawn in ~30 lines of
 * SVG. The pulse ring uses an SMIL animate (clamped under prefers-reduced-motion
 * globally), so it reads as a live target, not chrome.
 */
function SurfaceNodeGlyph() {
  // three rows of nodes, narrowing + rising for a faux-perspective mesh
  const ROWS = [
    { y: 78, xs: [20, 60, 100, 140, 180] },
    { y: 50, xs: [37, 68, 100, 132, 163] },
    { y: 24, xs: [54, 77, 100, 123, 146] },
  ];
  // the highlighted node — mid row, right of center, where the cursor lands
  const hot = { x: ROWS[1].xs[3], y: ROWS[1].y };

  return (
    <svg width="200" height="100" viewBox="0 0 200 100" fill="none" aria-hidden role="img">
      <g stroke="var(--line-strong)" strokeWidth="1" strokeLinecap="round">
        {/* mesh — horizontals along each row */}
        {ROWS.map((r, i) => (
          <polyline key={`h${i}`} points={r.xs.map((x) => `${x},${r.y}`).join(' ')} />
        ))}
        {/* mesh — verticals connecting each column across rows */}
        {ROWS[0].xs.map((_, c) => (
          <polyline key={`v${c}`} points={ROWS.map((r) => `${r.xs[c]},${r.y}`).join(' ')} />
        ))}
      </g>

      {/* faint dots at every node */}
      {ROWS.flatMap((r, i) =>
        r.xs.map((x, c) => <circle key={`d${i}-${c}`} cx={x} cy={r.y} r={1.6} fill="var(--text-3)" />),
      )}

      {/* the live target node */}
      <circle cx={hot.x} cy={hot.y} r={10} fill="var(--accent)" opacity={0.18}>
        <animate attributeName="r" values="6;13;6" dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.28;0;0.28" dur="2.4s" repeatCount="indefinite" />
      </circle>
      <circle cx={hot.x} cy={hot.y} r={4.5} fill="var(--accent)" />
      <circle cx={hot.x} cy={hot.y} r={4.5} fill="none" stroke="var(--bg-1)" strokeWidth={1.5} />

      {/* cursor about to click, tip pointing up-left toward the node */}
      <g transform={`translate(${hot.x + 5} ${hot.y + 4})`}>
        <path
          d="M0 0 L0 17 L4.5 12.5 L7.5 19 L9.8 18 L6.8 11.7 L12.5 11.7 Z"
          fill="var(--text-1)"
          stroke="var(--bg-0)"
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
