'use client';

/**
 * LiveTicker — a compact, always-fresh feed of the latest bets for the Pulse
 * dashboard (the full stream lives in the Live bets tool). New rows flash in via
 * the `rise` stagger; each links to the trader.
 */
import Link from 'next/link';
import { LuArrowUp, LuArrowDown } from 'react-icons/lu';
import type { FlowEvent } from '@/lib/analytics/flow';
import { num, ago, shortId } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import { WalletAvatar } from '../../leaderboard/wallet-avatar';

export function LiveTicker({ flow, loading }: { flow: FlowEvent[]; loading: boolean }) {
  const now = useNow(0);

  return (
    <div className="glass-card flex flex-col overflow-hidden">
      <div className="head-divider flex items-center gap-2 px-4 py-3">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-text-1">Latest bets</span>
      </div>

      {loading ? (
        <Skeleton />
      ) : flow.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-text-3">No bets yet.</div>
      ) : (
        <div className="rows-divided flex-1">
          {flow.map((f) => {
            const isUp = f.isUp;
            const isMint = f.kind === 'mint';
            const Dir = isUp ? LuArrowUp : LuArrowDown;
            return (
              <Link
                key={f.id}
                href={`/trader/${f.trader}`}
                className="flash-in flex items-center gap-2.5 px-4 py-2 transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
              >
                <span
                  className={`inline-flex h-5 w-5 flex-none items-center justify-center rounded-md ${isUp ? 'bg-up' : 'bg-down'} text-bg-0`}
                  style={{ opacity: isMint ? 1 : 0.55 }}
                >
                  <Dir size={11} />
                </span>
                <WalletAvatar addr={f.trader} size={16} ring="rgba(255,255,255,0.10)" />
                <span className="truncate font-mono text-[11px] text-text-2">{shortId(f.trader)}</span>
                <span className="ml-auto flex-none font-mono text-[11px] text-text-3">
                  {f.underlying} {num(f.strike, 0)}
                </span>
                <span className={`flex-none font-mono text-[11px] tabular-nums ${isMint ? 'text-text-1' : 'text-up'}`}>
                  {isMint ? '' : '+'}
                  {num(f.amount, 2)}
                </span>
                <span className="w-7 flex-none text-right font-mono text-[10px] tabular-nums text-text-3">{ago(f.ts, now)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="rows-divided">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5 px-4 py-2">
          <span className="h-5 w-5 flex-none rounded-md skeleton" />
          <span className="h-4 w-4 flex-none rounded-full skeleton" />
          <span className="h-3 w-20 rounded skeleton" />
          <span className="ml-auto h-3 w-16 rounded skeleton" />
        </div>
      ))}
    </div>
  );
}
