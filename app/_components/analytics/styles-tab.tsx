'use client';

/**
 * StylesTab — how the top traders bet. A distribution of archetypes across the
 * leaderboard's biggest traders, then the classified roster (each linking to its
 * profile). Built on the bounded useTraderStyles fan-out. Server-data only.
 */
import Link from 'next/link';
import { useTraderStyles } from '@/lib/hooks/use-trader-styles';
import { ALL_ARCHETYPES } from '@/lib/analytics/trader-style';
import { compact, shortId } from '@/lib/format';
import { WalletAvatar } from '../leaderboard/wallet-avatar';
import { TraderName } from '../leaderboard/trader-name';
import { StyleBadge, ARCH_VIS } from './style-badge';

export function StylesTab() {
  const { traders, distribution, loading, total } = useTraderStyles();

  const maxCount = Math.max(1, ...distribution.map((d) => d.count));

  return (
    <div className="space-y-4">
      {/* What the styles mean — plain-language legend, up top so the archetypes
          are explained before the distribution and roster reference them. */}
      <div className="glass-card overflow-hidden">
        <div className="head-divider px-4 py-3">
          <div className="text-[13px] font-semibold tracking-tight text-text-1">What the styles mean</div>
          <div className="eyebrow mt-0.5 text-text-3">worked out from each trader’s past bets</div>
        </div>
        <div className="grid gap-x-5 gap-y-3 p-4 sm:grid-cols-2">
          {ALL_ARCHETYPES.map((a) => {
            const vis = ARCH_VIS[a.id];
            const Icon = vis.icon;
            return (
              <div key={a.id} className="flex items-start gap-2.5">
                <span
                  className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-md"
                  style={{ color: vis.hue, background: `color-mix(in srgb, ${vis.hue} 14%, transparent)` }}
                >
                  <Icon size={13} />
                </span>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-text-1">{a.label}</div>
                  <div className="text-[11.5px] leading-snug text-text-3">{a.blurb}.</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Distribution */}
      <div className="glass-card overflow-hidden">
        <div className="head-divider px-4 py-3">
          <div className="text-[13px] font-semibold tracking-tight text-text-1">Trader styles</div>
          <div className="eyebrow mt-0.5 text-text-3">how the top {total} traders bet</div>
        </div>
        <div className="p-4">
          {loading ? (
            <BarsSkeleton />
          ) : distribution.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-text-3">Not enough trading history yet.</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {distribution.map((d) => {
                const vis = ARCH_VIS[d.id];
                const Icon = vis.icon;
                return (
                  <div key={d.id} className="flex items-center gap-3">
                    <span className="flex w-32 flex-none items-center gap-1.5 text-[12px] text-text-2">
                      <Icon size={13} style={{ color: vis.hue }} />
                      {d.label}
                    </span>
                    <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-bg-3">
                      <span
                        className="block h-full rounded-full transition-[width] duration-500"
                        style={{ width: `${(d.count / maxCount) * 100}%`, background: vis.hue, opacity: 0.7 }}
                      />
                    </span>
                    <span className="w-6 flex-none text-right font-mono text-[12px] tabular-nums text-text-2">
                      {d.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Classified roster */}
      <div className="glass-card overflow-hidden">
        <div className="head-divider px-4 py-3">
          <div className="text-[13px] font-semibold tracking-tight text-text-1">Top traders by style</div>
          <div className="eyebrow mt-0.5 text-text-3">ranked by amount bet · tap to view</div>
        </div>
        {loading ? (
          <RowsSkeleton />
        ) : traders.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-text-3">No classified traders yet.</div>
        ) : (
          <div className="rows-divided">
            {traders.map((t) => (
              <Link
                key={t.owner}
                href={`/trader/${t.owner}`}
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
              >
                <WalletAvatar addr={t.owner} size={22} ring="rgba(255,255,255,0.10)" />
                <span className="hidden w-28 flex-none truncate font-mono text-[12px] text-text-2 sm:block">
                  <TraderName owner={t.owner} />
                </span>
                <span className="w-28 flex-none truncate font-mono text-[12px] text-text-2 sm:hidden">
                  {shortId(t.owner)}
                </span>
                <span className="min-w-0 flex-1">
                  <StyleBadge style={t.style} size="sm" />
                </span>
                <span className="flex-none text-right font-mono text-[12px] tabular-nums text-text-2">
                  {compact(t.volume)}
                  <span className="ml-1 text-[10px] text-text-3">DUSDC</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BarsSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="h-3 w-32 flex-none rounded skeleton" />
          <span className="h-2 flex-1 rounded-full skeleton" />
        </div>
      ))}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="rows-divided">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <span className="h-5.5 w-5.5 flex-none rounded-full skeleton" />
          <span className="h-3 w-24 flex-none rounded skeleton" />
          <span className="h-5 flex-1 rounded skeleton" />
          <span className="h-3 w-12 flex-none rounded skeleton" />
        </div>
      ))}
    </div>
  );
}
