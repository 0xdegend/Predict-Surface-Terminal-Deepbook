'use client';

/**
 * WalletMixCard — admin view of how people sign in (Google vs Slush vs Other) and how
 * each converts to a real bet, over a time window (1D / 7D / 14D / All). Data from
 * /api/v2/admin/wallet-mix (counts only, no addresses); the window filters by when a
 * wallet FIRST connected. Forward-looking: it counts wallets seen since the beacon
 * shipped, so short windows fill in first. See [[wallet-mix-tracking]].
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LuWallet } from 'react-icons/lu';
import { num } from '@/lib/format';
import { WALLET_KINDS, WALLET_KIND_LABEL, type WalletKind } from '@/lib/wallet-kind';

type Range = '1d' | '7d' | '14d' | 'all';
const RANGE_LABEL: Record<Range, string> = { '1d': 'last 24h', '7d': 'last 7 days', '14d': 'last 14 days', all: 'all time' };

interface KindCount {
  connected: number;
  traded: number;
}
interface WalletMixSummary {
  range: string;
  kinds: Record<WalletKind, KindCount>;
  totalConnected: number;
  totalTraded: number;
  builtAtMs: number;
}

/** A hue per sign-in kind for the proportion bars (accent teal for Slush, a cool blue
 *  for Google, muted for Other) — a legend, not the app accent doing double duty. */
const KIND_HUE: Record<WalletKind, string> = {
  google: '#5b8def',
  slush: 'var(--up)',
  other: 'var(--text-3)',
};

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export function WalletMixCard() {
  const [range, setRange] = useState<Range>('all');
  const { data, isLoading } = useQuery<WalletMixSummary>({
    queryKey: ['admin', 'wallet-mix', range],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/v2/admin/wallet-mix?range=${range}`, { signal });
      if (!res.ok) throw new Error(`wallet-mix ${res.status}`);
      return (await res.json()) as WalletMixSummary;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const total = data?.totalConnected ?? 0;
  // Biggest cohort first, so the mix reads at a glance.
  const rows = [...WALLET_KINDS]
    .map((k) => ({ kind: k, ...(data?.kinds[k] ?? { connected: 0, traded: 0 }) }))
    .sort((a, b) => b.connected - a.connected);

  return (
    <div className="glass-card flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="eyebrow flex items-center gap-1.5">
            <LuWallet size={12} className="text-text-3" /> Wallet mix
          </span>
          <span className="text-[10px] text-text-3">
            how people sign in, and how many go on to bet · {RANGE_LABEL[range]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!isLoading && total > 0 && (
            <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-text-3">
              {num(total, 0)} connected · {num(data?.totalTraded ?? 0, 0)} traded
            </span>
          )}
          <RangeTabs value={range} onChange={setRange} />
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-28 items-center justify-center text-[11px] text-text-3">Loading…</div>
      ) : total === 0 ? (
        <p className="max-w-md text-[11px] leading-relaxed text-text-3">
          {range === 'all'
            ? 'No wallet connections tracked yet. This starts counting from when the feature shipped, so it fills in as people connect Google or Slush. It records only the sign-in type, never a Google identity.'
            : `No wallets connected in the ${RANGE_LABEL[range]}. Try a wider window.`}
        </p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {rows.map((r) => {
            const share = pct(r.connected, total);
            const conv = pct(r.traded, r.connected);
            const hue = KIND_HUE[r.kind];
            return (
              <div key={r.kind} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 font-mono text-[12px] tabular-nums">
                  <span className="flex items-center gap-2 text-text-1">
                    <span className="h-2 w-2 rounded-full" style={{ background: hue }} />
                    {WALLET_KIND_LABEL[r.kind]}
                    <span className="text-[10px] text-text-3">{share}%</span>
                  </span>
                  <span className="text-text-3">
                    <span className="text-text-1">{num(r.connected, 0)}</span> connected ·{' '}
                    <span className="text-up">{num(r.traded, 0)}</span> traded
                    {r.connected > 0 && <span className="ml-1.5 text-text-3">({conv}%)</span>}
                  </span>
                </div>
                {/* Proportion of all connections, with the traded portion filled solid. */}
                <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/5">
                  <div className="absolute inset-y-0 left-0 rounded-full opacity-30" style={{ width: `${share}%`, background: hue }} />
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: `${pct(r.traded, total)}%`, background: hue }}
                  />
                </div>
              </div>
            );
          })}
          <p className="text-[10px] leading-relaxed text-text-3">
            The faint bar is everyone who connected in this window; the solid fill is those who have
            placed a bet. The window filters by first connect. Traded comes from on-chain activity, so it
            also counts wallets that bet before this shipped.
          </p>
        </div>
      )}
    </div>
  );
}

/** Segmented time-window picker, mirroring the join-curve tabs on this page. */
function RangeTabs({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const opts: { key: Range; label: string }[] = [
    { key: '1d', label: '1D' },
    { key: '7d', label: '7D' },
    { key: '14d', label: '14D' },
    { key: 'all', label: 'All' },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-line bg-black/20 p-0.5">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
            value === o.key ? 'bg-(--accent-soft) text-accent' : 'text-text-3 hover:text-text-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
