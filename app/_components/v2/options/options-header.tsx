'use client';

/**
 * OptionsHeader — the page's top strip: asset + live price, the market-regime
 * pills (jumpiness / arb / lean / sentiment), the next-expiry countdown, and the
 * Plain/Pro toggle. A leaf that owns its OWN ticking (useNow + a cache read of the
 * live spot), so the live price and countdown update without re-rendering the
 * heavy surface above it.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNow } from '@/lib/hooks/use-now';
import { useMounted } from '@/lib/hooks/use-mounted';
import { pythSpot, qkV2 } from '@/lib/api/v2/client';
import { num, signed } from '@/lib/format';
import { VocabToggle } from './vocab';
import type { PythObservation } from '@/lib/api/v2/types';
import type { MarketIntel } from '@/lib/insights';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';

const VOL_LABEL = { calm: 'Calm', normal: 'Normal', elevated: 'Jumpy' } as const;

function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function OptionsHeader({ intel, insights, serverNow }: { intel: MarketIntel; insights: BtcInsights | null; serverNow: number }) {
  const now = useNow(serverNow);
  const mounted = useMounted();
  const qc = useQueryClient();
  // Read the live spot imperatively from the tape cache, but only after mount so
  // SSR and the first client render agree ("—") and it switches on after hydration
  // (no hydration mismatch). Same rule for the 24h change and the sentiment pill.
  const obs = mounted ? qc.getQueryData<PythObservation | null>(qkV2.pythLatest) ?? null : null;
  const spot = mounted ? pythSpot(obs) ?? intel.spot : null;
  const chg = mounted ? insights?.change24hPct ?? null : null;

  return (
    <header className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-3">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-linear-to-br from-[#f7931a] to-[#ffb64d] text-[12px] font-bold text-black">₿</span>
        <span className="text-[15px] font-semibold text-text-1">{intel.asset.label} Options</span>
      </div>

      {/* Live price + 24h change: widths reserved so the row holds its shape while
          the numbers load (no shrink, no shift — §10.7). */}
      <div className="flex items-baseline gap-2 font-mono">
        <span className="inline-block min-w-[7ch] text-[16px] tabular-nums text-text-1">{spot != null ? `$${num(spot, 0)}` : '—'}</span>
        <span className={`inline-block min-w-14 text-[12px] tabular-nums ${chg == null ? 'text-text-3' : chg >= 0 ? 'text-up' : 'text-down'}`}>
          {chg != null ? `${signed(chg, 2)}%` : ''}
        </span>
      </div>

      {/* Regime pills — each slot reserves its space with a placeholder until its
          datum arrives, so the cluster doesn't pop in and reflow the row. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {intel.vol ? (
          <Pill tone={intel.vol === 'elevated' ? 'down' : intel.vol === 'calm' ? 'up' : 'neutral'} label={VOL_LABEL[intel.vol]} />
        ) : (
          <PillSkel className="w-13" />
        )}
        {intel.arb ? (
          <Pill tone={intel.arb === 'watch' ? 'down' : 'up'} label={intel.arb === 'watch' ? 'Mispricing' : 'Arb-free'} />
        ) : (
          <PillSkel className="w-17.5" />
        )}
        {intel.bias ? (
          <Pill
            tone={intel.bias.pick === 'down' ? 'down' : intel.bias.pick === 'up' ? 'up' : 'neutral'}
            label={intel.bias.pick === 'range' ? 'No clear lean' : `Leaning ${intel.bias.pick}`}
          />
        ) : (
          <PillSkel className="w-23" />
        )}
        {mounted && insights?.sentiment ? (
          <Pill tone={insights.sentiment.value > 55 ? 'up' : insights.sentiment.value < 45 ? 'down' : 'neutral'} label={`${insights.sentiment.label} ${insights.sentiment.value}`} />
        ) : (
          <PillSkel className="w-17" />
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        {intel.nextExpiryMs != null && (
          <span className="font-mono text-[12px] text-text-2">
            next expiry <span className="inline-block min-w-13 text-right tabular-nums text-text-1">{countdown(intel.nextExpiryMs - now)}</span>
          </span>
        )}
        <VocabToggle />
      </div>
    </header>
  );
}

/** A faint fixed-width chip that reserves a regime pill's space until its datum
 *  loads, so the header keeps its shape while data streams in (no shrink / shift). */
function PillSkel({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`h-5 rounded-full bg-white/5 ring-1 ring-inset ring-line ${className}`} />;
}

function Pill({ label, tone }: { label: string; tone: 'up' | 'down' | 'neutral' }) {
  const cls =
    tone === 'up'
      ? 'bg-(--accent-soft) text-accent ring-(--accent-line)'
      : tone === 'down'
        ? 'bg-down/10 text-down ring-down/30'
        : 'bg-white/5 text-text-2 ring-line';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset ${cls}`}>{label}</span>;
}
