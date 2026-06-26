'use client';

/**
 * ConnectGate — the portfolio empty state shown before a wallet is connected.
 *
 * Rather than a lone card on an empty page, we render a faithful, BLURRED preview
 * of what the portfolio looks like once connected (account bento + a couple of
 * position cards with sample figures) and float the connect prompt on top. It
 * reads as "this is yours, one click away" instead of a dead end. The preview is
 * inert: `aria-hidden`, `pointer-events-none`, `select-none`, sample data only —
 * nothing is fetched or shared until a wallet actually connects. Connecting stays
 * owned by the top-bar wallet picker (the single wallet list), so this just guides
 * the eye there — no duplicate button.
 */
import type { IconType } from 'react-icons';
import {
  LuWallet,
  LuWalletMinimal,
  LuChartLine,
  LuLayers,
  LuTrendingUp,
  LuCoins,
  LuSparkles,
  LuArrowUp,
  LuArrowDown,
} from 'react-icons/lu';
import { HUE, IconChip } from '../ui/metric';
import { predictConfig } from '@/config/predict';

export function ConnectGate() {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* Blurred portfolio preview — a teaser of the connected view. Inert. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 select-none overflow-hidden"
      >
        <div className="origin-top scale-[1.02] opacity-70 blur-[5px] saturate-[0.9] mask-[linear-gradient(to_bottom,black,transparent_88%)]">
          <PortfolioPreview />
        </div>
      </div>

      {/* Scrim — darkens the preview so the connect card reads cleanly on top. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 95% at 50% 32%, rgba(10,11,13,0.55), rgba(10,11,13,0.9) 78%)',
        }}
      />

      {/* The connect prompt, floating centered over the preview. */}
      <div className="relative z-10 flex flex-1 items-center justify-center px-5 py-16">
        <div className="glass-card relative w-full max-w-md overflow-hidden p-8 text-center backdrop-blur-xl">
          {/* accent wash from the top + a faint top sheen — the one glow off-canvas */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 80% at 50% 0%, var(--accent-soft), transparent 62%)' }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-white/15 to-transparent"
          />

          <div className="relative flex flex-col items-center gap-5">
            <IconChip icon={LuWallet} color={HUE.teal} size={56} />

            <div className="flex flex-col gap-2">
              <h2 className="text-[18px] font-semibold tracking-tight text-text-1">
                Connect your wallet
              </h2>
              <p className="mx-auto max-w-xs text-[12.5px] leading-relaxed text-text-3">
                Here&apos;s your portfolio at a glance — account value, live PnL, and open positions
                light up the moment a wallet is connected. Nothing is shared until you do.
              </p>
            </div>

            {/* preview of what the portfolio surfaces once connected */}
            <div className="grid w-full grid-cols-3 gap-2">
              <FeatureTile icon={LuWallet} color={HUE.teal} label="Value" />
              <FeatureTile icon={LuChartLine} color={HUE.blue} label="Live PnL" />
              <FeatureTile icon={LuLayers} color={HUE.violet} label="Positions" />
            </div>

            <p className="text-[11px] text-text-3">
              Use the{' '}
              <span className="font-medium text-up">Connect</span> button in the top bar to get
              started.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A muted glass tile previewing one thing the portfolio shows once connected. */
function FeatureTile({ icon, color, label }: { icon: IconType; color: string; label: string }) {
  return (
    <div className="glass-inset flex flex-col items-center gap-2 px-2 py-3.5">
      <IconChip icon={icon} color={color} size={28} />
      <span className="text-[10px] uppercase tracking-wider text-text-3">{label}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   The inert preview: mirrors PortfolioPanel's account bento + position grid with
   illustrative sample figures. Visual only — never fetches, never interactive.
   ────────────────────────────────────────────────────────────────────────── */

function PortfolioPreview() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5">
      {/* Account header — same bento layout as the live portfolio. */}
      <div className="glass-card mb-6 grid grid-cols-2 gap-2.5 p-2.5 font-mono tabular-nums lg:grid-cols-3">
        {/* Account value — hero */}
        <div className="glass-inset relative col-span-2 flex flex-col gap-3 overflow-hidden p-4 lg:col-span-1">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 90% at 0% 0%, var(--accent-soft), transparent 60%)' }}
          />
          <div className="relative flex items-center gap-2.5">
            <IconChip icon={LuWallet} color={HUE.teal} size={30} />
            <span className="eyebrow">Account value</span>
          </div>
          <div className="relative flex flex-col gap-2">
            <span className="text-[34px] leading-none tracking-tight text-text-1">$12,480.50</span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-text-3">
              {predictConfig.quote.symbol} · {predictConfig.network}
            </span>
          </div>
        </div>

        <PreviewStat icon={LuTrendingUp} color={HUE.teal} label="Total PnL" value="+1,204.32" tone="up" />
        <PreviewStat icon={LuLayers} color={HUE.blue} label="Open exposure" value="$3,920.00" />
        <PreviewStat icon={LuCoins} color={HUE.amber} label="Trading account balance" value="$4,560.18" />
        <PreviewStat icon={LuWalletMinimal} color={HUE.violet} label="Wallet DUSDC" value="$2,000.00" />

        {/* Points — feature stat, mirrors PointsTile */}
        <div className="glass-inset relative col-span-2 flex flex-col gap-2 overflow-hidden p-4 lg:col-span-1">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 90% at 100% 0%, var(--accent-soft), transparent 60%)' }}
          />
          <div className="relative flex items-center gap-2">
            <IconChip icon={LuSparkles} color={HUE.teal} size={22} />
            <span className="eyebrow">Points</span>
          </div>
          <span className="relative text-[20px] leading-none tracking-tight text-accent">8,240</span>
          <span className="relative text-[10px] leading-relaxed text-text-3">
            Accrues from volume, performance &amp; holding time
          </span>
        </div>
      </div>

      {/* Open positions — same section header + grid as the live portfolio. */}
      <div className="mb-3 flex items-baseline gap-2">
        <span className="h-3 w-px bg-accent/70" />
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-2">
          Open positions
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PreviewPositionCard up underlying="BTC" strike="$72,000" pnl="+182.40" pnlPct="+12.4%" />
        <PreviewPositionCard up={false} underlying="ETH" strike="$3,400" pnl="-46.10" pnlPct="-4.2%" />
      </div>
    </div>
  );
}

/** A small bento stat card, mirroring PortfolioPanel's SmallStat. */
function PreviewStat({
  icon,
  color,
  label,
  value,
  tone,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: string;
  tone?: 'up' | 'down';
}) {
  const valueColor = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-1';
  return (
    <div className="glass-inset flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <IconChip icon={icon} color={color} size={22} />
        <span className="eyebrow">{label}</span>
      </div>
      <span className={`text-[20px] leading-none tracking-tight ${valueColor}`}>{value}</span>
    </div>
  );
}

/** A pared-down position card echoing PositionCard's silhouette (hero + PnL). */
function PreviewPositionCard({
  up,
  underlying,
  strike,
  pnl,
  pnlPct,
}: {
  up: boolean;
  underlying: string;
  strike: string;
  pnl: string;
  pnlPct: string;
}) {
  const accent = up ? 'var(--up)' : 'var(--down)';
  return (
    <div className={`glass-card relative overflow-hidden font-mono text-[12px] tabular-nums ${up ? 'up' : 'down'}`}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-0.5"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)`, opacity: 0.3 }}
      />
      <div className="flex flex-col gap-3 p-4">
        {/* top rail */}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${up ? 'bg-up' : 'bg-down'}`} />
            <span className="eyebrow">{underlying} Position</span>
          </span>
        </div>

        {/* hero — direction, the bet, PnL */}
        <div className="glass-inset flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-4">
          <div className="flex items-center gap-3">
            <span className={`dir-orb ${up ? 'up' : 'down'}`} aria-hidden>
              {up ? <LuArrowUp size={20} /> : <LuArrowDown size={20} />}
            </span>
            <div className="flex flex-col gap-1">
              <h3 className="text-[15px] leading-none text-text-1">{underlying}</h3>
              <p className="font-sans text-[11px] text-text-2">
                {underlying} {up ? '≥' : '≤'} {strike} at expiry
              </p>
              <span className="mt-1 w-fit rounded-full border border-line bg-white/3 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-text-2">
                Live
              </span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1">
            <span className="eyebrow">Unrealized PnL</span>
            <span className={`flex items-baseline gap-1.5 ${up ? 'text-up' : 'text-down'}`}>
              <span className="text-[30px] leading-none tracking-tight">{pnl}</span>
              <span className="text-[11px] text-text-3">DUSDC</span>
            </span>
            <span className={`text-[12px] ${up ? 'text-up' : 'text-down'}`}>{pnlPct}</span>
          </div>
        </div>

        {/* metrics row */}
        <div className="grid grid-cols-4 gap-x-4 px-1">
          {[
            ['Size', '120'],
            ['Avg entry', '38.0%'],
            ['Mark', '50.4%'],
            ['Value', '604.80'],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1.5">
              <span className="eyebrow text-text-3">{label}</span>
              <span className="text-[16px] leading-none tracking-tight text-text-1">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
