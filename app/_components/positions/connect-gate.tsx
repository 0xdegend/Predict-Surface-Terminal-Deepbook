'use client';

/**
 * ConnectGate — the portfolio empty state shown before a wallet is connected.
 * A frosted-glass hero matching the "Create trading account" card: accent wash,
 * top sheen, a wallet IconChip, and a preview of what the portfolio unlocks.
 * Connecting itself stays owned by the top-bar wallet picker (the single source
 * of the wallet list), so this just guides the eye there — no duplicate button.
 */
import type { IconType } from 'react-icons';
import { LuWallet, LuChartLine, LuLayers } from 'react-icons/lu';
import { HUE, IconChip } from '../ui/metric';

export function ConnectGate() {
  return (
    <div className="flex flex-1 items-center justify-center px-5 py-16">
      <div className="glass-card relative w-full max-w-md overflow-hidden p-8 text-center">
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
              Your account value, live PnL, and open positions appear here the moment a wallet is
              connected. Nothing is shared until you do.
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
